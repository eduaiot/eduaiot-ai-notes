import { App, Modal, Notice, TFile, TFolder } from 'obsidian';
import { message } from './backend';
import type AiNotesPlugin from './main';

export interface PickOptions {
  title: string;
  action: string;
  limit: number;
  min: number;
  initial: string[];
}

type Tab = 'recent' | 'folder';

const LIST = 20;

export class PickModal extends Modal {
  private readonly chosen: string[] = [];
  private readonly expanded = new Set<string>();
  private resolve: (paths: string[] | null) => void = () => undefined;
  private done = false;
  private tab: Tab = 'recent';
  private query = '';
  private timer = 0;
  private seq = 0;
  private tabsEl!: HTMLElement;
  private listEl!: HTMLElement;
  private chosenEl!: HTMLElement;
  private startButton!: HTMLButtonElement;

  constructor(app: App, private readonly plugin: AiNotesPlugin, private readonly options: PickOptions) {
    super(app);
    for (const path of options.initial) if (this.usable(path) && this.chosen.length < options.limit && !this.chosen.includes(path)) this.chosen.push(path);
  }

  pick(): Promise<string[] | null> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.open();
    });
  }

  private usable(path: string) {
    return this.plugin.local.engine.has(path);
  }

  private title(path: string) {
    return this.plugin.local.engine.title(path);
  }

  onOpen() {
    const { contentEl } = this;
    this.titleEl.setText(this.options.title);
    contentEl.addClass('eai-pick');
    const input = contentEl.createEl('input', { type: 'text', cls: 'eai-pick-input', attr: { placeholder: '输入文件名，或者想找的意思' } });
    input.oninput = () => {
      this.query = input.value.trim();
      this.renderList();
    };
    this.tabsEl = contentEl.createDiv({ cls: 'eai-tabs' });
    this.listEl = contentEl.createDiv({ cls: 'eai-pick-results' });
    this.chosenEl = contentEl.createDiv({ cls: 'eai-pick-chosen' });
    const actions = contentEl.createDiv({ cls: 'eai-actions' });
    this.startButton = actions.createEl('button', { cls: 'mod-cta' });
    this.startButton.onclick = () => this.finish([...this.chosen]);
    actions.createEl('button', { text: '取消' }).onclick = () => this.close();
    this.renderList();
    this.renderChosen();
    window.setTimeout(() => input.focus(), 0);
  }

  private toggle(path: string) {
    const at = this.chosen.indexOf(path);
    if (at >= 0) this.chosen.splice(at, 1);
    else if (this.chosen.length < this.options.limit) this.chosen.push(path);
    else new Notice(`最多选 ${this.options.limit} 篇`);
    this.renderChosen();
    this.renderList(false);
  }

  private row(parent: HTMLElement, path: string) {
    const picked = this.chosen.includes(path);
    const row = parent.createDiv({ cls: `eai-pick-row${picked ? ' is-picked' : ''}` });
    row.createSpan({ cls: 'eai-pick-mark', text: picked ? '✓' : '+' });
    const text = row.createDiv({ cls: 'eai-pick-text' });
    text.createDiv({ cls: 'eai-link', text: this.title(path) });
    text.createDiv({ cls: 'eai-meta', text: path.replace(/\.md$/i, '') });
    row.onclick = () => this.toggle(path);
  }

  private renderList(reset = true) {
    window.clearTimeout(this.timer);
    this.tabsEl.empty();
    this.listEl.empty();
    if (this.query) {
      this.renderSearch(reset);
      return;
    }
    const tabs: [Tab, string][] = [['recent', '最近打开和修改'], ['folder', '按文件夹']];
    for (const [tab, label] of tabs) {
      const button = this.tabsEl.createEl('button', { text: label, cls: this.tab === tab ? 'mod-cta' : '' });
      button.onclick = () => {
        this.tab = tab;
        this.renderList();
      };
    }
    if (this.tab === 'recent') this.renderRecent();
    else this.renderFolder(this.app.vault.getRoot(), this.listEl, 0);
  }

  private renderRecent() {
    const recent = this.app.workspace.getLastOpenFiles();
    const modified = this.app.vault.getMarkdownFiles().sort((a, b) => b.stat.mtime - a.stat.mtime).map((file) => file.path);
    const paths = [...new Set([...recent, ...modified])].filter((path) => this.usable(path)).slice(0, LIST);
    if (!paths.length) this.listEl.createDiv({ cls: 'eai-hint', text: '没有最近的笔记' });
    for (const path of paths) this.row(this.listEl, path);
  }

  private notesIn(folder: TFolder): TFile[] {
    return folder.children.filter((child): child is TFile => child instanceof TFile && this.usable(child.path));
  }

  private renderFolder(folder: TFolder, parent: HTMLElement, depth: number) {
    const folders = folder.children
      .filter((child): child is TFolder => child instanceof TFolder && !child.path.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    for (const child of folders) {
      const expanded = this.expanded.has(child.path);
      const notes = this.notesIn(child);
      const head = parent.createDiv({ cls: 'eai-pick-folder' });
      head.setCssStyles({ paddingLeft: `${depth * 14 + 4}px` });
      head.createSpan({ text: `${expanded ? '▾' : '▸'} 📁 ${child.name}` });
      if (notes.length) head.createSpan({ cls: 'eai-meta', text: ` ${notes.length} 篇` });
      head.onclick = () => {
        if (expanded) this.expanded.delete(child.path);
        else this.expanded.add(child.path);
        this.renderList(false);
      };
      if (expanded && notes.length) {
        const all = head.createEl('button', { cls: 'eai-pick-all', text: '全选' });
        all.onclick = (event) => {
          event.stopPropagation();
          for (const note of notes) if (!this.chosen.includes(note.path) && this.chosen.length < this.options.limit) this.chosen.push(note.path);
          this.renderChosen();
          this.renderList(false);
        };
      }
      if (!expanded) continue;
      this.renderFolder(child, parent, depth + 1);
      const box = parent.createDiv();
      box.setCssStyles({ paddingLeft: `${(depth + 1) * 14}px` });
      for (const note of notes.sort((a, b) => b.stat.mtime - a.stat.mtime)) this.row(box, note.path);
    }
    if (depth === 0) {
      const top = this.notesIn(folder);
      for (const note of top) this.row(parent, note.path);
    }
  }

  private renderSearch(reset: boolean) {
    const terms = this.query.toLowerCase().split(/\s+/).filter(Boolean);
    const named = this.app.vault.getMarkdownFiles()
      .filter((file) => this.usable(file.path))
      .filter((file) => {
        const target = `${file.path} ${this.title(file.path)}`.toLowerCase();
        return terms.every((term) => target.includes(term));
      })
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .slice(0, LIST)
      .map((file) => file.path);
    this.listEl.createDiv({ cls: 'eai-meta', text: `文件名匹配（${named.length}）` });
    for (const path of named) this.row(this.listEl, path);
    const semantic = this.listEl.createDiv();
    semantic.createDiv({ cls: 'eai-meta', text: '按意思找到' });
    const box = semantic.createDiv();
    box.createDiv({ cls: 'eai-hint', text: '正在找…' });
    const query = this.query;
    const seq = ++this.seq;
    this.timer = window.setTimeout(async () => {
      try {
        const hits = (await this.plugin.local.search(query, 12)).filter((hit) => !named.includes(hit.path) && this.usable(hit.path));
        if (seq !== this.seq) return;
        box.empty();
        if (!hits.length) box.createDiv({ cls: 'eai-hint', text: '没有更多' });
        for (const hit of hits) this.row(box, hit.path);
      } catch (error) {
        if (seq !== this.seq) return;
        box.empty();
        box.createDiv({ cls: 'eai-error', text: message(error) });
      }
    }, reset ? 400 : 0);
  }

  private renderChosen() {
    this.chosenEl.empty();
    this.chosenEl.createDiv({ cls: 'eai-meta', text: this.chosen.length ? `已选 ${this.chosen.length} 篇，按这个顺序使用` : `还没有选，至少选 ${this.options.min} 篇` });
    this.chosen.forEach((path, i) => {
      const row = this.chosenEl.createDiv({ cls: 'eai-pick-picked' });
      row.createSpan({ text: `${i + 1}. ${this.title(path)}` });
      const tools = row.createSpan({ cls: 'eai-pick-tools' });
      if (i > 0) {
        tools.createEl('button', { text: '↑' }).onclick = () => {
          [this.chosen[i - 1], this.chosen[i]] = [this.chosen[i], this.chosen[i - 1]];
          this.renderChosen();
        };
      }
      tools.createEl('button', { text: '×' }).onclick = () => this.toggle(path);
    });
    this.startButton.setText(`${this.options.action}（${this.chosen.length} 篇）`);
    this.startButton.disabled = this.chosen.length < this.options.min;
  }

  private finish(paths: string[] | null) {
    if (this.done) return;
    this.done = true;
    this.resolve(paths);
    this.close();
  }

  onClose() {
    this.finish(null);
    this.contentEl.empty();
  }
}
