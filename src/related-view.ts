import { ItemView, WorkspaceLeaf } from 'obsidian';
import { message } from './backend';
import type { Hit } from './core';
import type AiNotesPlugin from './main';

export const RELATED_VIEW = 'eduaiot-ai-notes-related';

export function renderHits(plugin: AiNotesPlugin, list: HTMLElement, hits: Hit[]) {
  for (const hit of hits) {
    const card = list.createDiv({ cls: 'eai-card' });
    const link = card.createEl('a', { cls: 'eai-link', text: hit.title, href: '#' });
    link.onclick = (event) => {
      event.preventDefault();
      void plugin.openNote(hit.path, hit.heading, hit.line);
    };
    if (hit.heading) card.createDiv({ cls: 'eai-meta', text: hit.heading });
    if (hit.snippet) card.createDiv({ cls: 'eai-snippet', text: hit.snippet });
  }
}

export class RelatedView extends ItemView {
  private path: string | null = null;
  private seq = 0;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: AiNotesPlugin) {
    super(leaf);
  }

  getViewType() {
    return RELATED_VIEW;
  }

  getDisplayText() {
    return '相关笔记';
  }

  getIcon() {
    return 'network';
  }

  async onOpen() {
    this.contentEl.addClass('eai-panel');
    await this.refresh(true);
  }

  async refresh(force = false) {
    const file = this.plugin.currentFile();
    const path = file?.path ?? '';
    if (!force && path === this.path) return;
    this.path = path;
    const seq = ++this.seq;
    const root = this.contentEl;
    root.empty();
    const head = root.createDiv({ cls: 'eai-head' });
    head.createSpan({ cls: 'eai-hint', text: this.plugin.modeLabel() });
    head.createEl('button', { text: '刷新' }).onclick = () => this.refresh(true);
    if (!file) {
      root.createEl('p', { cls: 'eai-hint', text: '打开一篇笔记，这里会列出你以前记过的相关内容。' });
      return;
    }
    root.createEl('h5', { text: `和「${file.basename}」相关的旧笔记` });
    const list = root.createDiv();
    list.createEl('p', { cls: 'eai-hint', text: '正在找…' });
    try {
      const hits = await this.plugin.backend.related(file.path, 8);
      if (seq !== this.seq) return;
      list.empty();
      if (!hits.length) list.createEl('p', { cls: 'eai-hint', text: '没有找到相关的笔记。' });
      renderHits(this.plugin, list, hits);
    } catch (error) {
      if (seq !== this.seq) return;
      list.empty();
      list.createEl('p', { cls: 'eai-error', text: message(error) });
    }
  }
}
