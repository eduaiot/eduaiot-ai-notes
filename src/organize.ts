import { getAllTags, getLinkpath, normalizePath, TFile, TFolder } from 'obsidian';
import { applyCuts, classifyMessages, parseClassify, sanitizePlan, cleanFolder, cleanTag, cleanTitle, DAY, findCuts, organizeMessages, parseNote, parseOrganize, parsePlan, planMessages, poorTitle, type Cut, type FolderSummary, type OrganizeInput, type PlanFolder } from './core';
import type AiNotesPlugin from './main';
import { aiRoot, ensureFolder, inRoot, readState, sourceLink, stamp, today, writeState } from './store';

const BATCH = 5;
const TEXT = 1500;
const RELATED = 5;
const RECENT_DAYS = 7;
export const RUN_LIMIT = 200;
const CLASSIFY_BATCH = 10;
const CLASSIFY_TEXT = 700;
export const ALL = '*';
export const ROOT = '/';
export const UNKNOWN = '未知';

const LINKS_SECTION = '相关笔记';

export interface Use {
  summary: boolean;
  tags: boolean;
  folder: boolean;
  title: boolean;
  links: boolean;
}

export interface Suggestion {
  path: string;
  mtime: number;
  summary: string;
  tags: string[];
  folder: string;
  title: string;
  links: string[];
  use: Use;
}

export interface Change {
  at: number;
  kind: 'move' | 'folder-new' | 'folder-move' | 'trash' | 'cut';
  from: string;
  to: string;
}

export interface MapNote {
  to: string;
  from: string;
  moved: boolean;
  renamed: boolean;
}

export interface MapFolder {
  path: string;
  name: string;
  folders: MapFolder[];
  notes: MapNote[];
  isNew: boolean;
  was: string[];
  total: number;
  changed: number;
}

interface OrganizeState {
  suggestions: Suggestion[];
  done: string[];
  skipped: string[];
  plan: PlanFolder[] | null;
  planScope: string;
  log: Change[];
}

export interface Health {
  total: number;
  untagged: string[];
  orphans: string[];
  poor: string[];
  recent: string[];
  empty: string[];
  emptyFolders: string[];
  duplicates: string[][];
}

function fresh(): OrganizeState {
  return { suggestions: [], done: [], skipped: [], plan: null, planScope: ALL, log: [] };
}

function folderOf(path: string) {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
}

export class Organizer {
  private state: OrganizeState = fresh();
  private loaded: Promise<void> | null = null;
  running = false;

  constructor(private readonly plugin: AiNotesPlugin) {}

  private get app() {
    return this.plugin.app;
  }

  private load() {
    if (!this.loaded) {
      this.loaded = readState(this.app, 'organize', fresh()).then((state) => {
        this.state = state;
        if (state.plan) state.plan = sanitizePlan(state.plan);
      });
    }
    return this.loaded;
  }

  private save() {
    return writeState(this.app, 'organize', this.state);
  }

  private tagsOf(file: TFile): string[] {
    const cache = this.app.metadataCache.getFileCache(file);
    return cache ? [...new Set((getAllTags(cache) ?? []).map((tag) => tag.replace(/^#/, '')))] : [];
  }

  private isAi(file: TFile) {
    const meta = this.app.metadataCache.getFileCache(file)?.frontmatter;
    return meta?.source === 'ai' || String(meta?.type ?? '').startsWith('ai-');
  }

  vocabulary(): string[] {
    const counts = new Map<string, number>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (this.isAi(file)) continue;
      for (const tag of this.tagsOf(file)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1]).map(([tag]) => tag);
  }

  folders(): string[] {
    const out: string[] = [];
    const walk = (folder: TFolder) => {
      for (const child of folder.children) {
        if (!(child instanceof TFolder) || child.path.startsWith('.') || child.path === aiRoot() || child.path.startsWith(`${aiRoot()}/`)) continue;
        if (this.plugin.local.excluded(`${child.path}/x.md`)) continue;
        out.push(child.path);
        walk(child);
      }
    };
    walk(this.app.vault.getRoot());
    return out.sort((a, b) => a.localeCompare(b, 'zh'));
  }

  async health(): Promise<Health> {
    await this.load();
    await this.plugin.local.start();
    const engine = this.plugin.local.engine;
    const own = new Set(this.notes().map((file) => file.path));
    const linked = new Set<string>();
    for (const [source, targets] of Object.entries(this.app.metadataCache.resolvedLinks)) {
      if (!own.has(source)) continue;
      for (const target of Object.keys(targets)) {
        if (target === source || !own.has(target)) continue;
        linked.add(source);
        linked.add(target);
      }
    }
    const handled = new Set([...this.state.done, ...this.state.skipped]);
    const since = Date.now() - RECENT_DAYS * DAY;
    const report: Health = { total: 0, untagged: [], orphans: [], poor: [], recent: [], empty: [], emptyFolders: [], duplicates: [] };
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (this.plugin.local.excluded(file.path) || this.isAi(file)) continue;
      report.total++;
      if (!engine.has(file.path)) {
        if (await this.isEmpty(file)) report.empty.push(file.path);
        continue;
      }
      const tags = this.tagsOf(file);
      const meta = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (!tags.length) report.untagged.push(file.path);
      if (!linked.has(file.path)) report.orphans.push(file.path);
      if (poorTitle(file.basename)) report.poor.push(file.path);
      if (file.stat.ctime >= since && !tags.length && !meta?.summary && !handled.has(file.path)) report.recent.push(file.path);
    }
    report.duplicates = engine.duplicates();
    report.emptyFolders = this.emptyFolders();
    return report;
  }

  private async isEmpty(file: TFile): Promise<boolean> {
    const cache = this.app.metadataCache.getFileCache(file);
    if (cache?.embeds?.length || cache?.links?.length || cache?.frontmatterLinks?.length) return false;
    const media = /https?:\/\/|\.(png|jpe?g|gif|webp|svg|bmp|heic|mp4|mov|m4v|webm|mp3|m4a|wav|ogg|flac|pdf)\b/i;
    const values = Object.values((cache?.frontmatter ?? {}) as Record<string, unknown>).flatMap((value): unknown[] => (Array.isArray(value) ? value : [value]));
    if (values.some((value) => typeof value === 'string' && media.test(value))) return false;
    const body = parseNote(await this.app.vault.cachedRead(file)).body.replace(/<!--[\s\S]*?-->|%%[\s\S]*?%%/g, '');
    if (/!\[[^\]]*\]\([^)]+\)|<(img|video|audio|iframe|embed|object)\b/i.test(body)) return false;
    return body.replace(/\s/g, '').length < 4;
  }

  async pendingCount(): Promise<number> {
    await this.load();
    return this.state.suggestions.length;
  }

  async suggestions(): Promise<Suggestion[]> {
    await this.load();
    this.state.suggestions = this.state.suggestions.filter((item) => this.app.vault.getAbstractFileByPath(item.path) instanceof TFile);
    return this.state.suggestions;
  }

  async generate(paths: string[], progress: (done: number, total: number) => void, scope = ALL): Promise<number> {
    await this.load();
    const local = this.plugin.local;
    if (!local.chatReady()) throw new Error('还没有设置好对话模型，请在插件设置里填写 API key');
    await local.start();
    const engine = local.engine;
    const queue = [...new Set(paths)].filter((path) => engine.has(path)).slice(0, RUN_LIMIT);
    const tags = this.vocabulary();
    const base = scope === ALL || scope === ROOT ? '' : scope;
    const folders = this.targetFolders().filter((path) => !base || path === base || path.startsWith(`${base}/`));
    let made = 0;
    this.running = true;
    try {
      for (let i = 0; i < queue.length; i += BATCH) {
        progress(i, queue.length);
        const batch = queue.slice(i, i + BATCH);
        const inputs: OrganizeInput[] = batch.map((path, n) => {
          const file = this.app.vault.getFileByPath(path);
          const group = engine.groups([path], null, TEXT)[0];
          return {
            n: n + 1,
            title: file?.basename ?? engine.title(path),
            folder: folderOf(path),
            tags: file ? this.tagsOf(file) : [],
            text: (group?.texts.join('\n\n') ?? '').slice(0, TEXT),
            related: engine.related(path, RELATED).map((hit, k) => ({ key: String.fromCharCode(97 + k), path: hit.path, title: hit.title }))
          };
        });
        const results = parseOrganize(await local.complete(organizeMessages(inputs, tags, folders), 2500), inputs, folders);
        batch.forEach((path, n) => {
          const result = results.get(n + 1);
          const file = this.app.vault.getAbstractFileByPath(path);
          if (!result || !(file instanceof TFile)) return;
          const current = folderOf(path);
          const existing = this.tagsOf(file);
          const tagsToAdd = result.tags.filter((tag) => !existing.includes(tag));
          const suggestion: Suggestion = {
            path,
            mtime: file.stat.mtime,
            summary: result.summary,
            tags: tagsToAdd,
            folder: result.folder || current,
            title: result.title && result.title !== file.basename ? result.title : '',
            links: result.links.filter((link) => link !== path),
            use: {
              summary: !!result.summary,
              tags: tagsToAdd.length > 0,
              folder: !!result.folder && result.folder !== current,
              title: !!result.title && result.title !== file.basename,
              links: result.links.length > 0
            }
          };
          this.state.suggestions = [suggestion, ...this.state.suggestions.filter((item) => item.path !== path)];
          made++;
        });
        await this.save();
      }
      progress(queue.length, queue.length);
      return made;
    } finally {
      this.running = false;
    }
  }

  async apply(suggestion: Suggestion): Promise<string> {
    await this.load();
    let file = this.app.vault.getAbstractFileByPath(suggestion.path);
    if (!(file instanceof TFile)) throw new Error('找不到这篇笔记，可能已经删除或改名');
    const { use } = suggestion;
    if ((use.summary && suggestion.summary) || (use.tags && suggestion.tags.length)) {
      await this.app.fileManager.processFrontMatter(file, (front: Record<string, unknown>) => {
        if (use.summary && suggestion.summary) front.summary = suggestion.summary;
        if (use.tags && suggestion.tags.length) {
          const raw = front.tags;
          const current: string[] = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.split(/[,\s]+/).filter(Boolean) : [];
          front.tags = [...new Set([...current.map((tag) => tag.replace(/^#/, '')), ...suggestion.tags.map(cleanTag).filter(Boolean)])];
        }
      });
    }
    if (use.links && suggestion.links.length) {
      const lines = suggestion.links
        .map((path) => this.app.vault.getAbstractFileByPath(path))
        .filter((target): target is TFile => target instanceof TFile)
        .map((target) => `- ${this.app.fileManager.generateMarkdownLink(target, file!.path)}`);
      if (lines.length) await this.app.vault.process(file, (text) => setLinks(text, lines));
    }
    const folder = use.folder ? suggestion.folder : folderOf(file.path);
    const name = use.title && cleanTitle(suggestion.title) ? cleanTitle(suggestion.title) : file.basename;
    const target = normalizePath(`${folder ? `${folder}/` : ''}${name}.md`);
    if (target !== file.path) {
      const before = file.path;
      if (folder) await ensureFolder(this.app, folder);
      let next = target;
      for (let i = 2; this.app.vault.getAbstractFileByPath(next); i++) next = normalizePath(`${folder ? `${folder}/` : ''}${name}-${i}.md`);
      await this.app.fileManager.renameFile(file, next);
      file = this.app.vault.getFileByPath(next) ?? file;
      this.record('move', before, next);
    }
    this.state.suggestions = this.state.suggestions.filter((item) => item !== suggestion && item.path !== suggestion.path);
    this.state.done = [...this.state.done.filter((path) => path !== suggestion.path), file.path].slice(-5000);
    await this.save();
    return file.path;
  }

  async skip(suggestion: Suggestion) {
    await this.load();
    this.state.suggestions = this.state.suggestions.filter((item) => item.path !== suggestion.path);
    this.state.skipped = [...this.state.skipped.filter((path) => path !== suggestion.path), suggestion.path].slice(-5000);
    await this.save();
  }

  async persist() {
    await this.load();
    await this.save();
  }

  private file(path: string): TFile {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`找不到「${path}」，可能已经删除或改名`);
    return file;
  }

  private record(kind: Change['kind'], from: string, to: string) {
    this.state.log = [...this.state.log, { at: Date.now(), kind, from, to }].slice(-5000);
  }

  private async moveToTrash(file: TFile) {
    this.record('trash', file.path, '');
    await this.app.fileManager.trashFile(file);
  }

  async trash(path: string) {
    await this.load();
    await this.moveToTrash(this.file(path));
    this.state.suggestions = this.state.suggestions.filter((item) => item.path !== path);
    await this.save();
  }

  private async retarget(from: TFile, to: TFile) {
    const sources = Object.entries(this.app.metadataCache.resolvedLinks)
      .filter(([source, targets]) => targets[from.path] && source !== from.path)
      .map(([source]) => source);
    for (const sourcePath of sources) {
      const source = this.app.vault.getAbstractFileByPath(sourcePath);
      if (!(source instanceof TFile)) continue;
      const cache = this.app.metadataCache.getFileCache(source);
      const refs = [...(cache?.links ?? []), ...(cache?.embeds ?? [])]
        .filter((ref) => this.app.metadataCache.getFirstLinkpathDest(getLinkpath(ref.link), sourcePath)?.path === from.path)
        .sort((a, b) => b.position.start.offset - a.position.start.offset);
      if (!refs.length) continue;
      await this.app.vault.process(source, (text) => {
        let next = text;
        for (const ref of refs) {
          if (next.slice(ref.position.start.offset, ref.position.end.offset) !== ref.original) continue;
          const at = ref.link.indexOf('#');
          const subpath = at >= 0 ? ref.link.slice(at) : undefined;
          const alias = ref.displayText && ref.displayText !== ref.link ? ref.displayText : undefined;
          let link = this.app.fileManager.generateMarkdownLink(to, sourcePath, subpath, alias);
          if (ref.original.startsWith('!') && !link.startsWith('!')) link = `!${link}`;
          next = next.slice(0, ref.position.start.offset) + link + next.slice(ref.position.end.offset);
        }
        return next;
      });
    }
  }

  async keepOnly(keep: string, group: string[]) {
    const keeper = this.file(keep);
    for (const path of group) {
      if (path === keep) continue;
      const other = this.file(path);
      await this.retarget(other, keeper);
      await this.moveToTrash(other);
    }
    await this.load();
    this.state.suggestions = this.state.suggestions.filter((item) => item.path === keep || !group.includes(item.path));
    await this.save();
  }

  async merge(keep: string, group: string[]) {
    const keeper = this.file(keep);
    const flat = (text: string) => parseNote(text).body.replace(/\s+/g, '');
    const own = flat(await this.app.vault.read(keeper));
    const tags = new Set<string>();
    const parts: string[] = [];
    for (const path of group) {
      if (path === keep) continue;
      const other = this.file(path);
      const text = await this.app.vault.read(other);
      for (const tag of this.tagsOf(other)) tags.add(tag);
      if (flat(text) && flat(text) !== own) parts.push(`### 合并自《${other.basename}》\n\n${parseNote(text).body.trim()}`);
    }
    if (parts.length) await this.app.vault.process(keeper, (text) => `${text.replace(/\s*$/, '')}\n\n${parts.join('\n\n')}\n`);
    if (tags.size) {
      await this.app.fileManager.processFrontMatter(keeper, (front: Record<string, unknown>) => {
        const raw = front.tags;
        const current: string[] = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.split(/[,\s]+/).filter(Boolean) : [];
        front.tags = [...new Set([...current.map((tag) => tag.replace(/^#/, '')), ...tags])];
      });
    }
    await this.keepOnly(keep, group);
  }

  private notes(): TFile[] {
    return this.app.vault.getMarkdownFiles().filter((file) => !this.plugin.local.excluded(file.path) && !this.isAi(file));
  }

  filesIn(scope: string): TFile[] {
    return this.notes().filter((file) => scope === ALL || (scope === ROOT ? !file.path.includes('/') : file.path.startsWith(`${scope}/`)));
  }

  async previewCuts(scope: string, start: string, end: string, headingOnly: boolean): Promise<{ path: string; cuts: Cut[] }[]> {
    const out: { path: string; cuts: Cut[] }[] = [];
    for (const file of this.filesIn(scope)) {
      const cuts = findCuts(await this.app.vault.cachedRead(file), start, end, headingOnly);
      if (cuts.length) out.push({ path: file.path, cuts });
    }
    return out;
  }

  async cut(path: string, start: string, end: string, headingOnly: boolean): Promise<number> {
    await this.load();
    const file = this.file(path);
    let removed = 0;
    await this.app.vault.process(file, (text) => {
      const cuts = findCuts(text, start, end, headingOnly);
      removed = cuts.reduce((sum, cut) => sum + cut.lines, 0);
      return applyCuts(text, cuts);
    });
    if (removed) {
      this.record('cut', path, `${removed} 行（从「${start}」到「${end}」）`);
      await this.save();
    }
    return removed;
  }

  notesIn(scope: string): string[] {
    const engine = this.plugin.local.engine;
    return this.notes()
      .filter((file) => engine.has(file.path))
      .filter((file) => scope === ALL || (scope === ROOT ? !file.path.includes('/') : file.path.startsWith(`${scope}/`)))
      .map((file) => file.path);
  }

  targetFolders(): string[] {
    const plan = this.state.plan ?? [];
    return [...new Set([...this.folders(), ...plan.map((folder) => folder.path)])].sort((a, b) => a.localeCompare(b, 'zh'));
  }

  async plan(): Promise<PlanFolder[] | null> {
    await this.load();
    if (this.state.plan) this.state.plan = sanitizePlan(this.state.plan);
    return this.state.plan;
  }

  async setPlan(plan: PlanFolder[] | null) {
    await this.load();
    this.state.plan = plan ? sanitizePlan(plan.map((folder) => ({ ...folder, path: cleanFolder(folder.path, 8) })).filter((folder) => folder.path)) : null;
    await this.save();
  }

  async planScope(): Promise<string> {
    await this.load();
    return this.state.planScope || ALL;
  }

  async generatePlan(scope: string): Promise<PlanFolder[]> {
    await this.load();
    const local = this.plugin.local;
    if (!local.chatReady()) throw new Error('还没有设置好对话模型，请在插件设置里填写 API key');
    await local.start();
    const base = scope === ALL || scope === ROOT ? '' : scope;
    const inScope = (path: string) => !base || path === base || path.startsWith(`${base}/`);
    const existing = this.folders().filter(inScope);
    const notes = this.notes().filter((file) => inScope(folderOf(file.path)));
    const titles = (files: TFile[], count: number) => files.sort((a, b) => b.stat.mtime - a.stat.mtime).slice(0, count).map((file) => file.basename.slice(0, 30));
    const summaries: FolderSummary[] = existing.filter((path) => path !== base).map((path) => {
      const inside = notes.filter((file) => folderOf(file.path) === path);
      return { path, count: notes.filter((file) => file.path.startsWith(`${path}/`)).length, titles: titles(inside, base ? 10 : 6) };
    });
    const loose = base ? notes : notes.filter((file) => folderOf(file.path) === base);
    const topics = base ? [] : ((await this.plugin.topics.state())?.topics ?? []).map((topic) => ({ name: topic.name, summary: topic.summary, count: topic.paths.length }));
    const locked = this.locked();
    const reply = await local.complete(planMessages(summaries, { path: base, count: loose.length, titles: titles(loose, base ? 80 : 6) }, topics, locked, base), 3000);
    const plan = sanitizePlan(parsePlan(reply, existing, base).filter((folder) => inScope(folder.path) && folder.path !== base));
    const kept: PlanFolder[] = [];
    for (const folder of plan) {
      const had = folder.from.length;
      folder.from = folder.from.filter((from) => from === folder.path || !this.isLocked(from, locked));
      if (had && !folder.from.length && !existing.includes(folder.path)) continue;
      kept.push(folder);
    }
    if (!kept.length) throw new Error('AI 没有给出可用的分类方案，请再试一次');
    this.state.plan = kept;
    this.state.planScope = scope;
    await this.save();
    return kept;
  }

  async classify(progress: (done: number, total: number) => void): Promise<{ moved: number; total: number }> {
    await this.load();
    const local = this.plugin.local;
    if (!local.chatReady()) throw new Error('还没有设置好对话模型，请在插件设置里填写 API key');
    await local.start();
    const plan = this.state.plan ? sanitizePlan(this.state.plan) : [];
    if (!plan.length) throw new Error('还没有分类方案');
    const scope = this.state.planScope || ALL;
    const unknown = scope === ALL || scope === ROOT ? UNKNOWN : `${scope}/${UNKNOWN}`;
    const paths = this.notesIn(scope).slice(0, RUN_LIMIT);
    const engine = local.engine;
    let moved = 0;
    this.running = true;
    try {
      for (let i = 0; i < paths.length; i += CLASSIFY_BATCH) {
        progress(i, paths.length);
        const batch = paths.slice(i, i + CLASSIFY_BATCH);
        const notes = batch.map((path, n) => {
          const file = this.app.vault.getFileByPath(path);
          const summary = (file ? this.app.metadataCache.getFileCache(file)?.frontmatter?.summary : undefined) as unknown;
          const body = engine.groups([path], null, CLASSIFY_TEXT)[0]?.texts.join('\n') ?? '';
          return { n: n + 1, title: engine.title(path), text: `${typeof summary === 'string' ? `摘要：${summary}\n` : ''}${body}`.slice(0, CLASSIFY_TEXT) };
        });
        const picks = parseClassify(await local.complete(classifyMessages(plan, notes), 1200), notes.length, plan.length);
        batch.forEach((path, n) => {
          const pick = picks.get(n + 1);
          const file = this.app.vault.getAbstractFileByPath(path);
          if (pick === undefined || !(file instanceof TFile)) return;
          const current = folderOf(path);
          const placed = plan.some((folder) => current === folder.path || current.startsWith(`${folder.path}/`));
          const target = pick ? plan[pick - 1]!.path : placed || current === unknown ? current : unknown;
          const existing = this.state.suggestions.find((item) => item.path === path);
          if (existing) {
            existing.folder = target;
            existing.use.folder = target !== current;
          }
          if (target === current) return;
          if (!existing) {
            this.state.suggestions.push({
              path,
              mtime: file.stat.mtime,
              summary: '',
              tags: [],
              folder: target,
              title: '',
              links: [],
              use: { summary: false, tags: false, folder: true, title: false, links: false }
            });
          }
          moved++;
        });
        await this.save();
      }
      progress(paths.length, paths.length);
      return { moved, total: paths.length };
    } finally {
      this.running = false;
    }
  }

  emptyFolders(): string[] {
    const locked = this.locked();
    const empty = (folder: TFolder): boolean => folder.children.every((child) => child instanceof TFolder && empty(child));
    return this.folders().filter((path) => {
      const folder = this.app.vault.getAbstractFileByPath(path);
      return folder instanceof TFolder && empty(folder) && !locked.includes(path) && !(this.state.plan ?? []).some((target) => target.path === path);
    });
  }

  async removeFolders(paths: string[]) {
    for (const path of [...paths].sort((a, b) => b.length - a.length)) {
      const folder = this.app.vault.getAbstractFileByPath(path);
      if (folder instanceof TFolder && !folder.children.length) await this.app.fileManager.trashFile(folder);
    }
  }

  locked(): string[] {
    const app = this.app as unknown as {
      vault: { getConfig?: (key: string) => unknown };
      internalPlugins?: { getPluginById?: (id: string) => { instance?: { options?: { folder?: unknown } } } | undefined };
      plugins?: { plugins?: Record<string, { settings?: Record<string, unknown> } | undefined> };
    };
    const plugin = (id: string, key: string) => app.plugins?.plugins?.[id]?.settings?.[key];
    const core = (id: string) => app.internalPlugins?.getPluginById?.(id)?.instance?.options?.folder;
    const raw = [
      app.vault.getConfig?.('attachmentFolderPath'),
      core('templates'),
      core('daily-notes'),
      plugin('eduaiot-wechat-sync', 'folder'),
      plugin('obsidian-excalidraw-plugin', 'folder'),
      plugin('templater-obsidian', 'templates_folder')
    ];
    const folders = new Set<string>();
    for (const value of raw) {
      if (typeof value !== 'string' || value.startsWith('.')) continue;
      const path = value.trim().replace(/^\/+|\/+$/g, '');
      if (path && this.app.vault.getAbstractFileByPath(path) instanceof TFolder) folders.add(path);
    }
    return [...folders].sort();
  }

  isLocked(folder: string, locked = this.locked()): boolean {
    return locked.some((path) => path === folder || path.startsWith(`${folder}/`));
  }

  private mapFolder(folder: string): string {
    let best: { from: string; to: string } | null = null;
    const locked = this.locked();
    for (const target of this.state.plan ?? []) {
      for (const from of target.from) {
        if (from === target.path || this.isLocked(from, locked) || !(folder === from || folder.startsWith(`${from}/`))) continue;
        if (!best || from.length > best.from.length) best = { from, to: target.path };
      }
    }
    return best ? `${best.to}${folder.slice(best.from.length)}` : folder;
  }

  async applyPlan(): Promise<number> {
    await this.load();
    const plan = this.state.plan ? sanitizePlan(this.state.plan) : null;
    if (!plan?.length) return 0;
    const targets = new Set(plan.map((folder) => folder.path));
    const protectedPath = (path: string) => [...targets].some((target) => target === path || target.startsWith(`${path}/`));
    let changes = 0;
    for (const target of plan) {
      const moving = target.from.some((from) => from !== target.path && !this.isLocked(from) && this.app.vault.getAbstractFileByPath(from) instanceof TFolder);
      if (moving && !(this.app.vault.getAbstractFileByPath(target.path) instanceof TFolder)) {
        await ensureFolder(this.app, target.path);
        this.record('folder-new', '', target.path);
        changes++;
      }
    }
    const locked = this.locked();
    for (const target of plan) {
      for (const from of target.from) {
        if (from === target.path || this.isLocked(from, locked)) continue;
        const source = this.app.vault.getAbstractFileByPath(from);
        if (!(source instanceof TFolder)) continue;
        this.record('folder-move', from, target.path);
        for (const child of [...source.children]) {
          if (child instanceof TFolder && protectedPath(child.path)) continue;
          const moved = this.notes().filter((file) => file.path === child.path || file.path.startsWith(`${child.path}/`));
          let next = normalizePath(`${target.path}/${child.name}`);
          for (let i = 2; this.app.vault.getAbstractFileByPath(next); i++) {
            next = normalizePath(child instanceof TFile ? `${target.path}/${child.basename}-${i}.${child.extension}` : `${target.path}/${child.name}-${i}`);
          }
          await this.app.fileManager.renameFile(child, next);
          for (const file of moved) this.record('move', file.path, `${next}${file.path.slice(child.path.length)}`);
          changes++;
        }
        if (!source.children.length && !protectedPath(source.path)) await this.app.fileManager.trashFile(source);
      }
    }
    this.state.plan = null;
    await this.save();
    return changes;
  }

  renamed(from: string, to: string) {
    if (!this.loaded) return;
    const swap = (path: string) => (path === from ? to : path.startsWith(`${from}/`) ? `${to}${path.slice(from.length)}` : path);
    for (const item of this.state.suggestions) {
      item.path = swap(item.path);
      item.links = item.links.map(swap);
    }
    this.state.done = this.state.done.map(swap);
    this.state.skipped = this.state.skipped.map(swap);
    void this.save();
  }

  async logSize(): Promise<number> {
    await this.load();
    return this.state.log.length;
  }

  async writeRecord(): Promise<TFile | null> {
    await this.load();
    const log = this.state.log;
    if (!log.length) return null;
    const final = new Map<string, string>();
    for (const change of log) {
      if (change.kind !== 'move') continue;
      const origin = [...final].find(([, to]) => to === change.from)?.[0] ?? change.from;
      final.set(origin, change.to);
    }
    const byFolder = new Map<string, { from: string; to: string }[]>();
    for (const [from, to] of final) {
      if (from === to) continue;
      const list = byFolder.get(folderOf(to)) ?? [];
      list.push({ from, to });
      byFolder.set(folderOf(to), list);
    }
    const link = (path: string) => {
      const file = this.app.vault.getAbstractFileByPath(path);
      return file instanceof TFile ? sourceLink({ n: 0, path, title: file.basename, heading: '' }) : `\`${path}\``;
    };
    const lines = ['---', `title: 整理记录 ${today()}`, 'type: 整理记录', 'source: ai', `created: ${today()}`, '---', '', `> [!ai] 这次整理一共改动 ${log.length} 处。笔记按整理后的位置列出，括号里是原来的位置。`, ''];
    const folders = log.filter((change) => change.kind === 'folder-new' || change.kind === 'folder-move');
    let section = 0;
    if (folders.length) {
      lines.push(`### ${++section}. 文件夹`, '');
      for (const change of folders) lines.push(change.kind === 'folder-new' ? `- 🆕 新建「${change.to}」` : `- 📁「${change.from}」的内容移到「${change.to}」`);
      lines.push('');
    }
    if (byFolder.size) {
      lines.push(`### ${++section}. 笔记`, '');
      for (const folder of [...byFolder.keys()].sort((a, b) => a.localeCompare(b, 'zh'))) {
        lines.push(`- 📁 ${folder || '根目录'}`);
        for (const item of byFolder.get(folder)!) {
          const renamed = item.from.split('/').pop() !== item.to.split('/').pop();
          lines.push(`  - ${link(item.to)}（原来：${item.from.replace(/\.md$/i, '')}${renamed ? '，已改名' : ''}）`);
        }
      }
      lines.push('');
    }
    const cuts = log.filter((change) => change.kind === 'cut');
    if (cuts.length) {
      lines.push(`### ${++section}. 删除的段落`, '');
      for (const change of cuts) lines.push(`- ✂️ ${link(change.from)}：删除 ${change.to}`);
      lines.push('');
    }
    const trashed = log.filter((change) => change.kind === 'trash');
    if (trashed.length) {
      lines.push(`### ${++section}. 移到回收站`, '');
      for (const change of trashed) lines.push(`- 🗑 ${change.from.replace(/\.md$/i, '')}`);
      lines.push('');
    }
    await ensureFolder(this.app, inRoot('整理记录'));
    let path = normalizePath(`${inRoot('整理记录')}/${stamp()} 整理记录.md`);
    for (let i = 2; this.app.vault.getAbstractFileByPath(path); i++) path = normalizePath(`${inRoot('整理记录')}/${stamp()} 整理记录-${i}.md`);
    const file = await this.app.vault.create(path, lines.join('\n'));
    this.state.log = [];
    await this.save();
    return file;
  }

  async map(): Promise<MapFolder> {
    await this.load();
    const plan = this.state.plan ?? [];
    const suggestions = new Map(this.state.suggestions.map((item) => [item.path, item]));
    const root: MapFolder = { path: '', name: '笔记库', folders: [], notes: [], isNew: false, was: [], total: 0, changed: 0 };
    const node = (path: string): MapFolder => {
      let at = root;
      let current = '';
      for (const part of path.split('/').filter(Boolean)) {
        current = current ? `${current}/${part}` : part;
        let next = at.folders.find((folder) => folder.name === part);
        if (!next) {
          const was = plan.filter((target) => target.path === current).flatMap((target) => target.from.filter((from) => from !== current));
          next = { path: current, name: part, folders: [], notes: [], isNew: !(this.app.vault.getAbstractFileByPath(current) instanceof TFolder), was, total: 0, changed: 0 };
          at.folders.push(next);
        }
        at = next;
      }
      return at;
    };
    for (const file of this.notes()) {
      const suggestion = suggestions.get(file.path);
      let folder = this.mapFolder(folderOf(file.path));
      if (suggestion?.use.folder) folder = this.mapFolder(suggestion.folder);
      const name = suggestion?.use.title && cleanTitle(suggestion.title) ? cleanTitle(suggestion.title) : file.basename;
      const to = normalizePath(`${folder ? `${folder}/` : ''}${name}.md`);
      node(folder).notes.push({ to, from: file.path, moved: folder !== folderOf(file.path), renamed: name !== file.basename });
    }
    const count = (folder: MapFolder): void => {
      folder.folders.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
      folder.notes.sort((a, b) => a.to.localeCompare(b.to, 'zh'));
      folder.folders.forEach(count);
      folder.total = folder.notes.length + folder.folders.reduce((sum, child) => sum + child.total, 0);
      folder.changed = folder.notes.filter((note) => note.moved || note.renamed).length + folder.folders.reduce((sum, child) => sum + child.changed, 0);
    };
    count(root);
    return root;
  }
}

function setLinks(text: string, lines: string[]): string {
  const rows = text.split('\n');
  const start = rows.findIndex((row) => new RegExp(`^#{1,6}\\s+(?:[\\d.]+\\s*)?${LINKS_SECTION}\\s*$`).test(row));
  if (start < 0) return `${text.replace(/\s*$/, '')}\n\n### ${LINKS_SECTION}\n\n${lines.join('\n')}\n`;
  const level = /^#+/.exec(rows[start]!)![0].length;
  let end = start + 1;
  while (end < rows.length && !(/^#{1,6}\s/.test(rows[end]!) && /^#+/.exec(rows[end]!)![0].length <= level)) end++;
  return [...rows.slice(0, start + 1), '', ...lines, '', ...rows.slice(end)].join('\n');
}
