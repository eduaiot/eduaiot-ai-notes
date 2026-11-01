import { normalizePath, TAbstractFile, TFile } from 'obsidian';
import { message, type AskResult, type Backend } from './backend';
import { askMessages, chat, embed, ModelError, NoteEngine, normalize, type Hit, type Message, type PinnedNote, type Turn, type VectorMeta } from './core';
import type AiNotesPlugin from './main';
import { embedConfig, embedId, modelConfig, modelLabel, modelReady, resolveModel } from './settings';

const BATCH = 10;
const SAVE_EVERY = 20;
const DEBOUNCE_MS = 1500;

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export class LocalBackend implements Backend {
  readonly kind = 'local';
  readonly engine = new NoteEngine();
  private ready: Promise<void> | null = null;
  private scanned = false;
  private embedding = false;
  private again = false;
  private stopped = false;
  private dirty = false;
  private embedError = '';
  private readonly timers = new Map<string, number>();

  constructor(private readonly plugin: AiNotesPlugin) {}

  private get app() {
    return this.plugin.app;
  }

  private file(name: string) {
    return normalizePath(`${this.plugin.manifest.dir}/index/${name}`);
  }

  get started() {
    return this.ready !== null;
  }

  start(): Promise<void> {
    if (!this.ready) this.ready = this.init();
    return this.ready;
  }

  private async init() {
    await this.loadVectors();
    await this.scan();
    this.plugin.refreshStatus();
    this.kick();
  }

  excluded(path: string): boolean {
    if (!/\.md$/i.test(path) || /\.excalidraw\.md$/i.test(path)) return true;
    if (path.startsWith(`${this.app.vault.configDir}/`)) return true;
    return this.plugin.settings.exclude
      .split('\n')
      .map((line) => line.trim().replace(/^\/+|\/+$/g, ''))
      .filter(Boolean)
      .some((folder) => path === folder || path.startsWith(`${folder}/`));
  }

  async scan() {
    const alive = new Set<string>();
    let count = 0;
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (this.excluded(file.path)) continue;
      alive.add(file.path);
      if (this.engine.mtime(file.path) === file.stat.mtime) continue;
      await this.index(file);
      if (++count % 50 === 0) {
        this.plugin.refreshStatus();
        await sleep(0);
      }
    }
    for (const path of this.engine.paths()) if (!alive.has(path)) this.engine.remove(path);
    this.scanned = true;
  }

  private async index(file: TFile) {
    try {
      this.engine.set(file.path, file.stat.mtime, await this.app.vault.cachedRead(file), file.stat.ctime);
    } catch {
      this.engine.remove(file.path);
    }
  }

  touch(file: TAbstractFile) {
    if (!this.started || !(file instanceof TFile)) return;
    window.clearTimeout(this.timers.get(file.path));
    this.timers.set(file.path, window.setTimeout(async () => {
      this.timers.delete(file.path);
      if (this.excluded(file.path)) this.engine.remove(file.path);
      else await this.index(file);
      this.plugin.refreshStatus();
      this.kick();
    }, DEBOUNCE_MS));
  }

  drop(path: string) {
    window.clearTimeout(this.timers.get(path));
    this.timers.delete(path);
    this.engine.remove(path);
  }

  async rescan() {
    if (!this.started) return;
    await this.ready;
    await this.scan();
    this.plugin.refreshStatus();
    this.kick();
  }

  async configChanged() {
    const id = embedId(this.plugin.settings);
    if (id !== this.engine.vectors.model) {
      this.engine.vectors.clear(id);
      this.embedError = '';
      this.dirty = true;
      await this.saveVectors();
    }
    this.kick();
  }

  async rebuildVectors() {
    this.engine.vectors.clear(embedId(this.plugin.settings));
    this.embedError = '';
    this.dirty = true;
    await this.saveVectors();
    this.kick();
  }

  embedProgress(): string {
    if (!embedConfig(this.plugin.settings)) return '没有设置向量模型，现在只按关键词找。';
    const done = this.engine.embeddedCount;
    const total = this.engine.chunkCount;
    if (this.embedError) return `向量计算暂停：${this.embedError}（已完成 ${done}/${total} 段）`;
    return `已计算 ${done}/${total} 段${this.embedding ? '，正在计算…' : ''}`;
  }

  statusText(): string {
    if (!this.started) return '未启动';
    const parts = [`已读 ${this.engine.noteCount} 篇`];
    if (embedConfig(this.plugin.settings)) {
      const done = this.engine.embeddedCount;
      const total = this.engine.chunkCount;
      if (this.embedError) parts.push('向量暂停');
      else if (done < total) parts.push(`向量 ${Math.floor((done / Math.max(total, 1)) * 100)}%`);
    }
    return parts.join(' · ');
  }

  kick() {
    if (this.embedding) {
      this.again = true;
      return;
    }
    void this.embedLoop();
  }

  private async embedLoop() {
    const settings = this.plugin.settings;
    const config = embedConfig(settings);
    if (this.stopped || !this.scanned || !config || !this.plugin.isActive(this)) return;
    const id = embedId(settings);
    if (id !== this.engine.vectors.model) return;
    this.embedding = true;
    this.again = false;
    this.embedError = '';
    let batches = 0;
    try {
      let queue = this.engine.pending();
      while (queue.length) {
        for (let i = 0; i < queue.length; i += BATCH) {
          if (this.stopped || !this.plugin.isActive(this) || embedId(settings) !== id) return;
          const batch = queue.slice(i, i + BATCH);
          const vectors = await embed(this.plugin.http, config, batch.map((chunk) => this.engine.embedInput(chunk)));
          if (embedId(settings) !== id) return;
          batch.forEach((chunk, n) => this.engine.vectors.set(chunk.key, vectors[n]));
          this.dirty = true;
          if (++batches % SAVE_EVERY === 0) await this.saveVectors();
          this.plugin.refreshStatus();
        }
        queue = this.engine.pending();
      }
    } catch (error) {
      this.embedError = message(error);
    } finally {
      this.embedding = false;
      await this.saveVectors();
      this.plugin.refreshStatus();
      if (this.again && !this.embedError) this.kick();
      else if (batches && !this.embedError && !this.engine.pending().length) this.plugin.vectorsDone();
    }
  }

  private async loadVectors() {
    const id = embedId(this.plugin.settings);
    const adapter = this.app.vault.adapter;
    try {
      if (id && await adapter.exists(this.file('vectors.json'))) {
        const meta = JSON.parse(await adapter.read(this.file('vectors.json'))) as VectorMeta;
        if (meta.model === id) {
          this.engine.vectors.load(meta, await adapter.readBinary(this.file('vectors.bin')));
          return;
        }
      }
    } catch {
      this.dirty = true;
    }
    this.engine.vectors.clear(id);
  }

  private async saveVectors() {
    if (!this.dirty) return;
    if (this.scanned) this.engine.prune();
    const { meta, data } = this.engine.vectors.encode();
    const adapter = this.app.vault.adapter;
    const dir = normalizePath(`${this.plugin.manifest.dir}/index`);
    try {
      if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
      await adapter.writeBinary(this.file('vectors.bin'), data);
      await adapter.write(this.file('vectors.json'), JSON.stringify(meta));
      this.dirty = false;
    } catch {
      this.dirty = true;
    }
  }

  async stop() {
    this.stopped = true;
    for (const timer of this.timers.values()) window.clearTimeout(timer);
    this.timers.clear();
    await this.saveVectors();
  }

  private async queryVector(text: string): Promise<Float32Array | null> {
    const settings = this.plugin.settings;
    const config = embedConfig(settings);
    if (!config || !this.engine.vectors.size || embedId(settings) !== this.engine.vectors.model) return null;
    try {
      const [vector] = await embed(this.plugin.http, config, [text.slice(0, 1000)]);
      return normalize(vector);
    } catch {
      return null;
    }
  }

  async search(query: string, limit: number): Promise<Hit[]> {
    await this.start();
    return this.engine.search(query, await this.queryVector(query), limit);
  }

  async related(path: string, limit: number): Promise<Hit[]> {
    await this.start();
    return this.engine.related(path, limit);
  }

  chatReady(use: string = 'task'): boolean {
    const settings = this.plugin.settings;
    return modelReady(settings, resolveModel(settings, use));
  }

  async complete(messages: Message[], maxTokens = 2000, use: string = 'task'): Promise<string> {
    const settings = this.plugin.settings;
    const entry = resolveModel(settings, use);
    if (!modelReady(settings, entry)) throw new ModelError(`模型「${entry ? modelLabel(entry) : '未设置'}」还没有设置好（API key、接口地址或模型名称），请在插件设置里填写`);
    return chat(this.plugin.http, modelConfig(settings, entry), messages, maxTokens);
  }

  vectorCoverage(): number {
    return this.engine.chunkCount ? this.engine.embeddedCount / this.engine.chunkCount : 0;
  }

  async ask(question: string, history: Turn[], pin: PinnedNote | null, model?: string): Promise<AskResult> {
    const use = model || 'chat';
    const entry = resolveModel(this.plugin.settings, use);
    if (!this.chatReady(use)) throw new ModelError(`模型「${modelLabel(entry)}」还没有设置好（API key、接口地址或模型名称），请在插件设置里填写`);
    await this.start();
    const query = `${question}\n${history.length ? history[history.length - 1].q : ''}`;
    const groups = this.engine.context(query, await this.queryVector(query), pin);
    const answer = await this.complete(askMessages(question, history, groups, await this.plugin.profile.promptText()), 2000, entry.id);
    return { answer, sources: groups.map((group) => group.source), model: modelLabel(entry) };
  }
}
