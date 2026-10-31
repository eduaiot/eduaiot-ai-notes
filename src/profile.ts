import { normalizePath, Notice, TFile } from 'obsidian';
import { message } from './backend';
import {
  CONFIRMED,
  confirmedProfile,
  DAY,
  INFERRED,
  insertProfileItems,
  interviewLines,
  kmeans,
  topicCount,
  normalizeProfileText,
  parseProfile,
  parseSuggestions,
  profileMessages,
  profileSkeleton,
  seeded,
  shuffle,
  type ProfileItem
} from './core';
import type AiNotesPlugin from './main';
import { embedConfig } from './settings';
import { aiRoot, ensureFolder, inRoot, readState, sourceLink, writeState } from './store';

export function profilePath() {
  return inRoot('我的画像.md');
}
const RECENT = 20;
const RANDOM = 20;
const FIRST_MAX = 15;
const WEEKLY_MAX = 8;
const FIRST_COVERAGE = 0.9;

interface ProfileState {
  rejected: string[];
  lastUpdate: number;
  interviewed?: boolean;
}

export class ProfileManager {
  private busy = false;
  private cache: ProfileItem[] | null = null;

  constructor(private readonly plugin: AiNotesPlugin) {}

  private get app() {
    return this.plugin.app;
  }

  private file(): TFile | null {
    const file = this.app.vault.getAbstractFileByPath(profilePath());
    return file instanceof TFile ? file : null;
  }

  invalidate(path: string) {
    if (path === profilePath()) this.cache = null;
  }

  async items(): Promise<ProfileItem[]> {
    if (!this.cache) {
      const file = this.file();
      this.cache = file ? parseProfile(await this.app.vault.cachedRead(file)) : [];
    }
    return this.cache;
  }

  async promptText(): Promise<string> {
    return confirmedProfile(await this.items());
  }

  async pending(): Promise<ProfileItem[]> {
    return (await this.items()).filter((item) => !item.confirmed);
  }

  async open() {
    const file = this.file() ?? (await this.ensure());
    await this.app.workspace.getLeaf(true).openFile(file);
  }

  private async ensure(): Promise<TFile> {
    const existing = this.file();
    if (existing) return existing;
    await ensureFolder(this.app, aiRoot());
    return this.app.vault.create(profilePath(), profileSkeleton());
  }

  private async edit(item: ProfileItem, change: (line: string) => string | null) {
    const file = this.file();
    if (!file) return;
    await this.app.vault.process(file, (text) => {
      const lines = text.split(/\r?\n/);
      const at = lines[item.line] === item.raw ? item.line : lines.indexOf(item.raw);
      if (at < 0) return text;
      const next = change(lines[at]);
      if (next === null) lines.splice(at, 1);
      else lines[at] = next;
      return lines.join('\n');
    });
    this.cache = null;
  }

  async confirm(item: ProfileItem) {
    await this.edit(item, (line) => line.replace(INFERRED, CONFIRMED));
  }

  async reject(item: ProfileItem) {
    const state = await this.state();
    state.rejected = [...state.rejected.filter((text) => text !== item.text), item.text].slice(-100);
    await writeState(this.app, 'profile', state);
    await this.edit(item, () => null);
  }

  private sample(): string[] {
    const notes = this.plugin.local.engine.list().sort((a, b) => b.mtime - a.mtime);
    const recent = notes.slice(0, RECENT).map((note) => note.path);
    const older = shuffle(notes.slice(RECENT).map((note) => note.path), seeded(String(Date.now()))).slice(0, RANDOM);
    return [...recent, ...older];
  }

  private async sampleFirst(): Promise<{ paths: string[]; by: string }> {
    const engine = this.plugin.local.engine;
    const notes = engine.list().sort((a, b) => b.mtime - a.mtime);
    const total = RECENT + RANDOM;
    const spread = (groups: string[][]) => {
      const out: string[] = [];
      for (let round = 0; out.length < total && groups.some((group) => group.length > round); round++) {
        for (const group of groups) if (group[round] && out.length < total) out.push(group[round]);
      }
      return out;
    };
    if (this.vectorsReady()) {
      const saved = await this.plugin.topics.state();
      let groups = saved?.topics.map((topic) => topic.paths.filter((path) => engine.has(path))) ?? [];
      if (!groups.length) {
        const items = notes.map((note) => ({ path: note.path, vector: engine.noteVector(note.path) })).filter((item): item is { path: string; vector: Float32Array } => !!item.vector);
        groups = kmeans(items, topicCount(items.length)).map((topic) => topic.paths);
      }
      if (groups.length > 1) return { paths: spread(groups), by: `${groups.length} 个主题` };
    }
    const folders = new Map<string, string[]>();
    for (const note of notes) {
      const key = note.path.includes('/') ? note.path.split('/')[0] : '';
      folders.set(key, [...(folders.get(key) ?? []), note.path]);
    }
    return { paths: spread([...folders.values()]), by: `${folders.size} 个文件夹` };
  }

  private state(): Promise<ProfileState> {
    return readState<ProfileState>(this.app, 'profile', { rejected: [], lastUpdate: 0, interviewed: false });
  }

  vectorsReady(): boolean {
    const local = this.plugin.local;
    return !!embedConfig(this.plugin.settings) && local.engine.vectors.size > 0 && local.vectorCoverage() >= FIRST_COVERAGE;
  }

  async status(): Promise<{ first: boolean; waiting: boolean; coverage: number; interviewed: boolean }> {
    const state = await this.state();
    const first = state.lastUpdate === 0;
    const waiting = first && !!embedConfig(this.plugin.settings) && !this.vectorsReady();
    return { first, waiting, coverage: this.plugin.local.vectorCoverage(), interviewed: !!state.interviewed };
  }

  async saveInterview(answers: Record<string, string>) {
    const lines = interviewLines(answers);
    const file = await this.ensure();
    if (lines.length) await this.app.vault.process(file, (text) => insertProfileItems(text, lines));
    this.cache = null;
    const state = await this.state();
    state.interviewed = true;
    await writeState(this.app, 'profile', state);
    return lines.length;
  }

  async skipInterview() {
    const state = await this.state();
    state.interviewed = true;
    await writeState(this.app, 'profile', state);
  }

  async update(open = true): Promise<number> {
    if (this.busy) {
      new Notice('画像正在更新，请稍等');
      return 0;
    }
    const local = this.plugin.local;
    if (!local.chatReady()) {
      new Notice('还没有设置好对话模型，请在插件设置里填写 API Key');
      return 0;
    }
    this.busy = true;
    let notice: Notice | null = null;
    try {
      await local.start();
      const state = await this.state();
      const first = state.lastUpdate === 0;
      const picked = first ? await this.sampleFirst() : { paths: this.sample(), by: '' };
      const groups = local.engine.groups(picked.paths, null, 20000);
      if (groups.length < 3) {
        new Notice('笔记太少，至少要有 3 篇笔记才能更新画像');
        return 0;
      }
      const max = first ? FIRST_MAX : WEEKLY_MAX;
      notice = new Notice(first ? `第一次分析画像：从 ${picked.by}里挑了 ${groups.length} 篇代表笔记…` : `正在根据 ${groups.length} 篇笔记更新画像…`, 0);
      const current = await this.items();
      const reply = await local.complete(profileMessages(current, state.rejected, groups, max), 2500);
      const known = new Set([...current.map((item) => item.text), ...state.rejected].map(normalizeProfileText));
      const lines: { section: string; line: string }[] = [];
      for (const suggestion of parseSuggestions(reply, groups.length, max)) {
        const key = normalizeProfileText(suggestion.text);
        if (!key || known.has(key)) continue;
        known.add(key);
        const evidence = suggestion.evidence.map((n) => sourceLink(groups[n - 1].source)).join('、');
        lines.push({ section: suggestion.section, line: `- ${INFERRED} ${suggestion.text}（依据：${evidence}）` });
      }
      const file = await this.ensure();
      if (lines.length) await this.app.vault.process(file, (text) => insertProfileItems(text, lines));
      this.cache = null;
      state.lastUpdate = Date.now();
      await writeState(this.app, 'profile', state);
      notice.hide();
      notice = null;
      new Notice(lines.length ? `画像新增 ${lines.length} 条，等你确认` : '这次没有发现新的内容');
      if (open) await this.app.workspace.getLeaf(true).openFile(file);
      return lines.length;
    } catch (error) {
      new Notice(`画像更新失败：${message(error)}`, 8000);
      return 0;
    } finally {
      notice?.hide();
      this.busy = false;
    }
  }

  async weekly() {
    if (!this.plugin.local.chatReady()) return;
    const state = await this.state();
    if (state.lastUpdate === 0) {
      if (embedConfig(this.plugin.settings) && !this.vectorsReady()) return;
      new Notice('开始第一次分析你的画像，结果会放在今日侧栏等你确认');
      await this.update(false);
      this.plugin.refreshToday();
      return;
    }
    if (Date.now() - state.lastUpdate < 6 * DAY) return;
    await this.update(false);
  }
}
