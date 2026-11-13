import { App, Modal, normalizePath, Notice, SuggestModal, TFile } from 'obsidian';
import { message } from './backend';
import { bridges, fill, INSPIRE_TASK, kmeans, namingMessages, normalize, parseNames, skillMessages, topicCount, type Bridge, type Topic } from './core';
import type AiNotesPlugin from './main';
import { aiRoot, ensureFolder, inRoot, readState, sourceLink, today, writeAiNote, writeState } from './store';


const MIN_COVERAGE = 0.6;
const MIN_NOTES = 6;

export interface SavedTopic {
  id: number;
  name: string;
  summary: string;
  paths: string[];
}

interface TopicState {
  at: number;
  topics: SavedTopic[];
  bridges: Bridge[];
  total?: number;
  added?: string[];
  manual?: Record<string, number>;
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

export class TopicMapper {
  private busy = false;
  private cache: TopicState | null = null;

  constructor(private readonly plugin: AiNotesPlugin) {}

  private get app() {
    return this.plugin.app;
  }

  async state(): Promise<TopicState | null> {
    if (!this.cache) {
      const saved = await readState<TopicState>(this.app, 'topics', { at: 0, topics: [], bridges: [] });
      this.cache = saved.topics.length ? saved : null;
    }
    return this.cache;
  }

  async topicOf(path: string): Promise<SavedTopic | null> {
    return (await this.state())?.topics.find((topic) => topic.paths.includes(path)) ?? null;
  }

  async isAdded(path: string): Promise<boolean> {
    return (await this.state())?.added?.includes(path) ?? false;
  }

  private async save(state: TopicState) {
    await writeState(this.app, 'topics', state);
    this.cache = state;
    await this.writeMap(state);
  }

  async catchUp(): Promise<number> {
    const state = await this.state();
    if (!state || this.busy) return 0;
    await this.plugin.local.start();
    const engine = this.plugin.local.engine;
    let changed = false;
    for (const topic of state.topics) {
      const alive = topic.paths.filter((path) => engine.has(path) || this.app.vault.getFileByPath(path));
      if (alive.length !== topic.paths.length) changed = true;
      topic.paths = alive;
    }
    const centroids: { topic: SavedTopic; vector: Float32Array }[] = [];
    for (const topic of state.topics) {
      let sum: Float32Array | null = null;
      for (const path of topic.paths) {
        const vector = engine.noteVector(path);
        if (!vector) continue;
        sum ??= new Float32Array(vector.length);
        for (let i = 0; i < vector.length; i++) sum[i]! += vector[i]!;
      }
      if (sum) centroids.push({ topic, vector: normalize(sum) });
    }
    const placed = new Set(state.topics.flatMap((topic) => topic.paths));
    const added = new Set((state.added ?? []).filter((path) => placed.has(path)));
    let count = 0;
    for (const note of engine.list()) {
      if (placed.has(note.path)) continue;
      const vector = engine.noteVector(note.path);
      if (!vector || !centroids.length) continue;
      let best = centroids[0]!;
      let score = -Infinity;
      for (const item of centroids) {
        const value = dot(vector, item.vector);
        if (value > score) {
          score = value;
          best = item;
        }
      }
      best.topic.paths.push(note.path);
      placed.add(note.path);
      added.add(note.path);
      count++;
    }
    if (!count && !changed) return 0;
    state.added = [...added];
    await this.save(state);
    return count;
  }

  async move(path: string, id: number): Promise<boolean> {
    const state = await this.state();
    const target = state?.topics.find((topic) => topic.id === id);
    if (!state || !target) return false;
    for (const topic of state.topics) topic.paths = topic.paths.filter((item) => item !== path);
    target.paths.unshift(path);
    state.manual = { ...state.manual, [path]: id };
    state.added = (state.added ?? []).filter((item) => item !== path);
    await this.save(state);
    new Notice(`已放进主题「${target.name}」`);
    return true;
  }

  async rename(from: string, to: string) {
    const state = await this.state();
    if (!state) return;
    let changed = false;
    for (const topic of state.topics) {
      const at = topic.paths.indexOf(from);
      if (at < 0) continue;
      topic.paths[at] = to;
      changed = true;
    }
    for (const bridge of state.bridges) {
      if (bridge.a === from) bridge.a = to;
      if (bridge.b === from) bridge.b = to;
    }
    if (state.manual && from in state.manual) {
      state.manual[to] = state.manual[from]!;
      delete state.manual[from];
    }
    if (state.added) state.added = state.added.map((item) => (item === from ? to : item));
    if (changed) await writeState(this.app, 'topics', state);
  }

  async choose(path: string): Promise<boolean> {
    const state = await this.state();
    if (!state) {
      new Notice('还没有主题地图，先在今日侧栏点「主题地图」生成一次');
      return false;
    }
    const current = state.topics.find((topic) => topic.paths.includes(path))?.id ?? -1;
    const picked = await new TopicSuggest(this.app, state.topics.filter((topic) => topic.id !== current)).pick();
    return picked ? this.move(path, picked.id) : false;
  }

  async assignments(): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    for (const topic of (await this.state())?.topics ?? []) for (const path of topic.paths) map.set(path, topic.id);
    return map;
  }

  private ready(): string {
    const local = this.plugin.local;
    if (!local.chatReady()) return '还没有设置好对话模型，请在插件设置里填写 API key';
    if (!local.engine.vectors.size) return '主题地图要先打开「按意思搜索」，请在插件设置里选好服务，等它准备好';
    const coverage = local.vectorCoverage();
    if (coverage < MIN_COVERAGE) return `按意思搜索还没准备好（${Math.floor(coverage * 100)}%），到 ${MIN_COVERAGE * 100}% 以上再试`;
    return '';
  }

  async show() {
    if (await this.state()) await this.plugin.openGraph();
    else await this.build();
  }

  async build(open = true): Promise<TopicState | null> {
    if (this.busy) {
      new Notice('主题地图正在生成，请稍等');
      return null;
    }
    await this.plugin.local.start();
    const problem = this.ready();
    if (problem) {
      new Notice(problem, 8000);
      return null;
    }
    this.busy = true;
    const notice = new Notice('正在分析笔记的主题…', 0);
    const old = await this.state();
    try {
      const engine = this.plugin.local.engine;
      const items = engine.list()
        .map((note) => ({ path: note.path, vector: engine.noteVector(note.path) }))
        .filter((item): item is { path: string; vector: Float32Array } => !!item.vector);
      if (items.length < MIN_NOTES) {
        new Notice(`至少要有 ${MIN_NOTES} 篇准备好按意思搜索的笔记`);
        return null;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      const topics = kmeans(items, topicCount(items.length));
      const manual = this.keepManual(old, topics);
      const vectors = new Map(items.map((item) => [item.path, item.vector]));
      const links = bridges(topics, (path) => vectors.get(path) ?? null, 8);
      const ids = topics.map((topic) => topic.id);
      const messages = namingMessages(topics.map((topic) => ({
        id: topic.id,
        notes: topic.paths.slice(0, 6).map((path) => ({ title: engine.title(path), preview: engine.preview(path, 60) }))
      })));
      const names = parseNames(await this.plugin.local.complete(messages, 1500), ids);
      if (names.size < ids.length) {
        const again = parseNames(await this.plugin.local.complete(messages, 1500), ids);
        for (const [id, name] of again) if (!names.has(id)) names.set(id, name);
      }
      const fallback = (path: string) => {
        const title = engine.title(path).replace(/^\d{8}-\d{3}\s*/, '');
        return title.length > 12 ? `${title.slice(0, 12)}…` : title;
      };
      const state: TopicState = {
        at: Date.now(),
        topics: topics.map((topic) => ({
          id: topic.id,
          name: names.get(topic.id)?.name || fallback(topic.paths[0] ?? ''),
          summary: names.get(topic.id)?.summary ?? '',
          paths: topic.paths
        })),
        bridges: links,
        total: items.length,
        added: [],
        manual
      };
      await this.save(state);
      notice.hide();
      if (open) await this.plugin.openGraph();
      new Notice(`主题地图已生成：${state.topics.length} 个主题`);
      return state;
    } catch (error) {
      notice.hide();
      new Notice(`主题地图生成失败：${message(error)}`, 8000);
      return null;
    } finally {
      this.busy = false;
    }
  }

  private keepManual(old: TopicState | null, topics: Topic[]): Record<string, number> {
    const manual = old?.manual ?? {};
    const kept: Record<string, number> = {};
    for (const [path, id] of Object.entries(manual)) {
      if (!this.plugin.local.engine.has(path)) continue;
      const peers = new Set((old?.topics.find((topic) => topic.id === id)?.paths ?? []).filter((item) => item !== path && !(item in manual)));
      let best: Topic | null = null;
      let score = 0;
      for (const topic of topics) {
        const overlap = topic.paths.filter((item) => peers.has(item)).length;
        if (overlap > score) {
          score = overlap;
          best = topic;
        }
      }
      if (!best) continue;
      for (const topic of topics) topic.paths = topic.paths.filter((item) => item !== path);
      best.paths.unshift(path);
      kept[path] = best.id;
    }
    return kept;
  }

  private async writeMap(state: TopicState): Promise<TFile> {
    const engine = this.plugin.local.engine;
    const link = (path: string) => sourceLink({ n: 0, path, title: engine.title(path), heading: '' });
    const name = (id: number) => state.topics.find((topic) => topic.id === id)?.name ?? `主题 ${id + 1}`;
    const lines = [
      '---',
      'title: 主题地图',
      'type: 主题地图',
      'source: ai',
      `created: ${today()}`,
      '---',
      '',
      `> [!ai] AI 按内容把 ${engine.list().length} 篇笔记自动分成 ${state.topics.length} 个主题，主题名由 AI 起。重新生成会覆盖这篇。`,
      '> 想看关系图：命令面板运行「打开主题图谱」，或者在今日侧栏点「主题地图」。',
      ''
    ];
    state.topics.forEach((topic, i) => {
      lines.push(`### ${i + 1}. ${topic.name}（${topic.paths.length} 篇）`, '');
      if (topic.summary) lines.push(topic.summary, '');
      lines.push(...topic.paths.slice(0, 10).map((path) => `- ${link(path)}`));
      if (topic.paths.length > 10) lines.push(`- ……还有 ${topic.paths.length - 10} 篇`);
      lines.push('');
    });
    if (state.bridges.length) {
      lines.push(`### ${state.topics.length + 1}. 跨领域连接`, '', '不同主题里内容最接近的笔记，适合放在一起想新点子。运行「跨领域灵感」会根据这些连接生成灵感卡。', '');
      for (const bridge of state.bridges) {
        lines.push(`- ${link(bridge.a)}（${name(bridge.ta)}）↔ ${link(bridge.b)}（${name(bridge.tb)}）`);
      }
      lines.push('');
    }
    await ensureFolder(this.app, aiRoot());
    return this.put(inRoot('主题地图.md'), lines.join('\n'));
  }

  private async put(path: string, content: string): Promise<TFile> {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
      return existing;
    }
    return this.app.vault.create(normalizePath(path), content);
  }

  async inspire(): Promise<TFile | null> {
    const local = this.plugin.local;
    let state = await this.state();
    const engine = local.engine;
    await local.start();
    const alive = (path: string) => engine.has(path);
    if (!state || Date.now() - state.at > 7 * 86_400_000 || !state.bridges.some((bridge) => alive(bridge.a) && alive(bridge.b))) {
      state = await this.build(false);
      if (!state) return null;
    }
    const name = (id: number) => state.topics.find((topic) => topic.id === id)?.name ?? `主题 ${id + 1}`;
    const candidates = state.bridges.filter((bridge) => alive(bridge.a) && alive(bridge.b));
    if (!candidates.length) {
      new Notice('没有找到跨领域的连接');
      return null;
    }
    const pairs = await new BridgeModal(this.app, candidates, (path) => engine.title(path), name).pick();
    if (!pairs?.length) return null;
    const paths = pairs.flatMap((pair) => [pair.a, pair.b]);
    const groups = engine.groups(paths, null, 16000);
    const number = new Map(groups.map((group) => [group.source.path, group.source.n]));
    const labels: Record<string, string> = {};
    for (const pair of pairs) {
      labels[pair.a] = `主题：${name(pair.ta)}`;
      labels[pair.b] = `主题：${name(pair.tb)}`;
    }
    const list = pairs.map((pair, i) => `组合 ${i + 1}：[${number.get(pair.a)}]《${engine.title(pair.a)}》（${name(pair.ta)}）× [${number.get(pair.b)}]《${engine.title(pair.b)}》（${name(pair.tb)}）`).join('\n');
    const notice = new Notice(`正在根据 ${pairs.length} 组跨领域连接生成灵感…`, 0);
    try {
      const text = await local.complete(skillMessages(fill(INSPIRE_TASK, { pairs: list }), groups, '', labels, await this.plugin.profile.promptText()), 4000);
      const file = await writeAiNote(this.app, {
        folder: inRoot('灵感'),
        name: '跨领域灵感',
        title: `跨领域灵感 ${today()}`,
        kind: '跨领域灵感',
        body: text,
        sources: groups.map((group) => group.source)
      });
      notice.hide();
      await this.app.workspace.getLeaf(true).openFile(file);
      return file;
    } catch (error) {
      notice.hide();
      new Notice(`跨领域灵感生成失败：${message(error)}`, 8000);
      return null;
    }
  }
}

class BridgeModal extends Modal {
  private readonly chosen = new Set<number>();
  private resolve: (pairs: Bridge[] | null) => void = () => undefined;
  private done = false;

  constructor(
    app: App,
    private readonly bridges: Bridge[],
    private readonly title: (path: string) => string,
    private readonly topic: (id: number) => string
  ) {
    super(app);
    bridges.slice(0, 4).forEach((_, i) => this.chosen.add(i));
  }

  pick(): Promise<Bridge[] | null> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  onOpen() {
    const { contentEl } = this;
    this.titleEl.setText('选择要碰一碰的组合');
    contentEl.createEl('p', { cls: 'eai-hint', text: '每个组合是两个不同主题里内容最接近的两篇笔记，按接近程度排序，默认选了前 4 组。每组会生成一张灵感卡。' });
    const list = contentEl.createDiv({ cls: 'eai-pick-results' });
    const start = contentEl.createDiv({ cls: 'eai-actions' }).createEl('button', { cls: 'mod-cta' });
    const update = () => {
      start.setText(`生成灵感（${this.chosen.size} 组）`);
      start.disabled = !this.chosen.size;
    };
    this.bridges.forEach((bridge, i) => {
      const row = list.createEl('label', { cls: 'eai-pick-row eai-bridge' });
      const box = row.createEl('input', { type: 'checkbox' });
      box.checked = this.chosen.has(i);
      box.onchange = () => {
        if (box.checked) this.chosen.add(i);
        else this.chosen.delete(i);
        update();
      };
      const text = row.createDiv({ cls: 'eai-pick-text' });
      text.createDiv({ cls: 'eai-link', text: `${this.title(bridge.a)} × ${this.title(bridge.b)}` });
      text.createDiv({ cls: 'eai-meta', text: `${this.topic(bridge.ta)} × ${this.topic(bridge.tb)} · 接近度 ${Math.round(bridge.score * 100)}%` });
    });
    start.onclick = () => this.finish(this.bridges.filter((_, i) => this.chosen.has(i)));
    start.parentElement!.createEl('button', { text: '取消' }).onclick = () => this.close();
    update();
  }

  private finish(pairs: Bridge[] | null) {
    if (this.done) return;
    this.done = true;
    this.resolve(pairs);
    this.close();
  }

  onClose() {
    this.finish(null);
    this.contentEl.empty();
  }
}

class TopicSuggest extends SuggestModal<SavedTopic> {
  private resolve: (topic: SavedTopic | null) => void = () => undefined;
  private chosen: SavedTopic | null = null;

  constructor(app: App, private readonly topics: SavedTopic[]) {
    super(app);
    this.setPlaceholder('选一个主题，回车确定');
  }

  pick(): Promise<SavedTopic | null> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  getSuggestions(query: string): SavedTopic[] {
    const text = query.trim().toLowerCase();
    return this.topics.filter((topic) => !text || topic.name.toLowerCase().includes(text) || topic.summary.toLowerCase().includes(text));
  }

  renderSuggestion(topic: SavedTopic, el: HTMLElement) {
    el.createDiv({ text: `${topic.name} · ${topic.paths.length} 篇` });
    if (topic.summary) el.createDiv({ cls: 'eai-meta', text: topic.summary });
  }

  onChooseSuggestion(topic: SavedTopic) {
    this.chosen = topic;
  }

  onClose() {
    window.setTimeout(() => this.resolve(this.chosen), 0);
  }
}
