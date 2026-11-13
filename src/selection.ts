import { Component, MarkdownView, Notice, setIcon, TFile } from 'obsidian';
import { answerText, modelPicker, renderAnswer, retryButtons, shownSources } from './answer';
import { ASK_VIEW, AskView } from './ask-view';
import { message } from './backend';
import type { Source, Turn } from './core';
import type AiNotesPlugin from './main';
import { SearchModal } from './search-modal';
import { sourceLink, sourceTexts } from './store';

const QUICK = ['解释一下', '总结要点', '和我哪些笔记有关', '能怎么用到我的项目'];
const PANEL_WIDTH = 400;

interface Picked {
  text: string;
  rect: DOMRect;
  view: MarkdownView;
  line: number;
}

interface Item {
  q: string;
  a: string;
  current: string;
  model?: string;
  modelId: string;
  sources: Source[];
  texts: Map<number, string>;
  error: string;
  pending: boolean;
}

export class SelectionTools {
  private bar: HTMLElement | null = null;
  private panel: HTMLElement | null = null;
  private picked: Picked | null = null;
  private items: Item[] = [];
  private renderer = new Component();
  private timer = 0;
  private spot: { left: number; top: number; width: number; height: number } | null = null;
  private model = '';
  private slot: HTMLElement | null = null;
  private chips: HTMLElement | null = null;

  constructor(private readonly plugin: AiNotesPlugin) {}

  enable() {
    const plugin = this.plugin;
    plugin.registerDomEvent(document, 'mouseup', (event) => {
      if (this.inside(event.target)) return;
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.check(), 20);
    });
    plugin.registerDomEvent(document, 'keyup', (event) => {
      if (!event.shiftKey && !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      if (this.inside(event.target)) return;
      window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.check(), 300);
    });
    plugin.registerDomEvent(document, 'mousedown', (event) => {
      if (!this.inside(event.target)) this.hideBar();
    });
    plugin.registerDomEvent(document, 'keydown', (event) => {
      if (event.key === 'Escape') {
        this.hideBar();
        this.hidePanel();
      }
    });
    plugin.registerDomEvent(document, 'scroll', () => this.hideBar(), { capture: true });
    plugin.register(() => {
      this.hideBar();
      this.hidePanel();
    });
  }

  private inside(target: EventTarget | null) {
    return target instanceof Node && (!!this.bar?.contains(target) || !!this.panel?.contains(target));
  }

  private pick(): Picked | null {
    if (!this.plugin.settings.selectionTools) return null;
    const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    const dom = window.getSelection();
    if (!view || !dom || dom.isCollapsed || !dom.rangeCount) return null;
    const range = dom.getRangeAt(0);
    if (!view.contentEl.contains(range.commonAncestorContainer)) return null;
    const text = (view.getMode() === 'source' ? view.editor.getSelection() : dom.toString()).trim();
    if (text.replace(/\s/g, '').length < 2) return null;
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return null;
    return { text, rect, view, line: view.getMode() === 'source' ? view.editor.getCursor('to').line : -1 };
  }

  private check() {
    const picked = this.pick();
    if (!picked) {
      this.hideBar();
      return;
    }
    this.picked = picked;
    this.showBar(picked);
  }

  private place(el: HTMLElement, rect: DOMRect, width: number, below: boolean) {
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + rect.width / 2 - width / 2));
    const height = el.offsetHeight || 40;
    let top = below ? rect.bottom + 8 : rect.top - height - 8;
    if (top < 8) top = rect.bottom + 8;
    if (top + height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - height - 8);
    el.setCssStyles({ left: `${left}px`, top: `${top}px` });
  }

  private showBar(picked: Picked) {
    this.hideBar();
    const bar = document.body.createDiv({ cls: 'eai-selbar' });
    this.bar = bar;
    const button = (icon: string, text: string, run: () => void) => {
      const el = bar.createEl('button', { cls: 'eai-selbar-button' });
      setIcon(el.createSpan(), icon);
      el.createSpan({ text });
      el.onmousedown = (event) => event.preventDefault();
      el.onclick = () => {
        this.hideBar();
        run();
      };
    };
    button('sparkles', '问 AI', () => this.openPanel(picked));
    button('search', '找相关', () => new SearchModal(this.plugin.app, this.plugin, picked.text.slice(0, 200)).open());
    button('lightbulb', '灵感卡', () => {
      const file = picked.view.file;
      void this.plugin.skills.runByName('灵感卡', { file: file instanceof TFile ? file : null, selection: picked.text });
    });
    this.place(bar, picked.rect, bar.offsetWidth || 220, false);
  }

  private hideBar() {
    this.bar?.remove();
    this.bar = null;
  }

  private hidePanel() {
    this.renderer.unload();
    this.panel?.remove();
    this.panel = null;
    this.items = [];
  }

  private openPanel(picked: Picked) {
    this.hidePanel();
    this.picked = picked;
    this.renderer = new Component();
    this.renderer.load();
    const panel = document.body.createDiv({ cls: 'eai-selpanel' });
    this.panel = panel;
    panel.setCssStyles({ width: `${PANEL_WIDTH}px` });
    const head = panel.createDiv({ cls: 'eai-head eai-selhead' });
    head.title = '按住这里可以拖动';
    const grip = head.createSpan({ cls: 'eai-selgrip' });
    setIcon(grip, 'grip-horizontal');
    head.createSpan({ cls: 'eai-link', text: '问 AI' });
    head.createDiv({ cls: 'eai-selmode' });
    const fold = head.createEl('button', { cls: 'clickable-icon' });
    setIcon(fold, 'chevron-up');
    fold.title = '收起';
    fold.onclick = () => {
      const folded = !panel.hasClass('is-folded');
      panel.toggleClass('is-folded', folded);
      setIcon(fold, folded ? 'chevron-down' : 'chevron-up');
      fold.title = folded ? '展开' : '收起';
    };
    const close = head.createEl('button', { cls: 'clickable-icon' });
    setIcon(close, 'x');
    close.title = '关闭';
    close.onclick = () => this.hidePanel();
    this.draggable(panel, head);
    const content = panel.createDiv({ cls: 'eai-selbody' });
    content.createDiv({ cls: 'eai-selquote', text: picked.text.length > 300 ? `${picked.text.slice(0, 300)}…` : picked.text });
    const list = content.createDiv({ cls: 'eai-selmessages' });
    const chips = content.createDiv({ cls: 'eai-selchips' });
    this.chips = chips;
    const form = content.createDiv({ cls: 'eai-form' });
    const input = form.createEl('textarea', { cls: 'eai-textarea', attr: { placeholder: '想问这段什么？Enter 发送，Shift+Enter 换行', rows: '2' } });
    const send = () => {
      const q = input.value.trim();
      if (!q) return;
      input.value = '';
      void this.ask(q, list, chips);
    };
    for (const q of QUICK) {
      const chip = chips.createEl('button', { cls: 'eai-chip', text: q });
      chip.onclick = () => void this.ask(q, list, chips);
    }
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        send();
      }
    });
    const footer = form.createDiv({ cls: 'eai-form-footer' });
    this.slot = footer.createDiv({ cls: 'eai-model-slot' });
    this.renderPicker();
    footer.createEl('button', { cls: 'mod-cta', text: '发送' }).onclick = send;
    if (this.spot) {
      panel.setCssStyles({ width: `${this.spot.width}px` });
      if (this.spot.height) panel.setCssStyles({ height: `${this.spot.height}px` });
      this.moveTo(panel, this.spot.left, this.spot.top);
    } else {
      this.place(panel, picked.rect, PANEL_WIDTH, true);
    }
    window.setTimeout(() => input.focus(), 0);
  }

  private renderPicker() {
    if (!this.slot) return;
    this.slot.empty();
    modelPicker(this.plugin, this.slot, this.model, (id) => {
      this.model = id === this.plugin.defaultChat() ? '' : id;
    });
  }

  private moveTo(panel: HTMLElement, left: number, top: number) {
    const width = panel.offsetWidth || PANEL_WIDTH;
    const x = Math.max(8 - width + 80, Math.min(window.innerWidth - 80, left));
    const y = Math.max(0, Math.min(window.innerHeight - 40, top));
    panel.setCssStyles({ left: `${x}px`, top: `${y}px` });
  }

  private remember(panel: HTMLElement) {
    const rect = panel.getBoundingClientRect();
    this.spot = { left: rect.left, top: rect.top, width: rect.width, height: panel.style.height ? rect.height : 0 };
  }

  private draggable(panel: HTMLElement, handle: HTMLElement) {
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || (event.target instanceof Element && event.target.closest('button'))) return;
      event.preventDefault();
      const rect = panel.getBoundingClientRect();
      const dx = event.clientX - rect.left;
      const dy = event.clientY - rect.top;
      handle.setPointerCapture(event.pointerId);
      panel.addClass('is-dragging');
      const move = (next: PointerEvent) => this.moveTo(panel, next.clientX - dx, next.clientY - dy);
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        panel.removeClass('is-dragging');
        this.remember(panel);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
    new ResizeObserver(() => {
      if (panel.isConnected && panel.style.height && !panel.hasClass('is-folded')) this.remember(panel);
    }).observe(panel);
  }

  private async ask(q: string, list: HTMLElement, chips: HTMLElement) {
    const picked = this.picked;
    if (!picked || this.items.some((item) => item.pending)) return;
    chips.hide();
    const file = picked.view.file;
    const item: Item = { q, a: '', current: file?.basename ?? '', modelId: this.model || this.plugin.defaultChat(), sources: [], texts: new Map(), error: '', pending: true };
    const history: Turn[] = this.items.filter((entry) => !entry.error).map((entry) => ({ q: entry.q, a: entry.a }));
    this.items.push(item);
    this.renderItems(list);
    try {
      const question = history.length ? q : `关于我选中的这段文字：\n「${picked.text.slice(0, 1500)}」\n\n${q}`;
      const pin = file instanceof TFile ? { path: file.path, text: await this.plugin.app.vault.cachedRead(file) } : null;
      const result = await this.plugin.backend.ask(question, history, pin, item.modelId);
      item.model = result.model;
      item.a = result.answer;
      item.sources = result.sources;
      item.texts = await sourceTexts(this.plugin.app, result.sources);
    } catch (error) {
      item.error = message(error);
    }
    item.pending = false;
    if (this.panel) this.renderItems(list);
  }

  private renderItems(list: HTMLElement) {
    this.renderer.unload();
    this.renderer = new Component();
    this.renderer.load();
    list.empty();
    for (const item of this.items) {
      list.createDiv({ cls: 'eai-question', text: item.q });
      const answer = list.createDiv({ cls: 'eai-answer' });
      if (item.pending) {
        answer.createEl('p', { cls: 'eai-hint', text: '正在翻笔记…' });
        continue;
      }
      if (item.error) {
        answer.createEl('p', { cls: 'eai-error', text: item.error });
        retryButtons(this.plugin, answer, item.modelId, (id) => {
          this.model = id === this.plugin.defaultChat() ? '' : id;
          this.renderPicker();
          this.items = this.items.filter((entry) => entry !== item);
          if (this.chips) void this.ask(item.q, list, this.chips);
        });
        continue;
      }
      renderAnswer(this.plugin, answer, item, this.renderer);
      if (item.model) answer.createDiv({ cls: 'eai-meta', text: `由 ${item.model} 回答` });
      const actions = answer.createDiv({ cls: 'eai-actions' });
      actions.createEl('button', { text: '复制' }).onclick = async () => {
        await navigator.clipboard.writeText(answerText(item.a));
        new Notice('已复制');
      };
      const insert = actions.createEl('button', { text: '插入到下方' });
      insert.onclick = () => this.insert(item);
      actions.createEl('button', { text: '在侧栏继续' }).onclick = () => this.continueInSidebar();
    }
    list.scrollTop = list.scrollHeight;
  }

  private insert(item: Item) {
    const picked = this.picked;
    if (!picked) return;
    const view = picked.view;
    if (view.getMode() !== 'source') {
      new Notice('阅读模式下不能插入，请切换到编辑模式再试');
      return;
    }
    const sources = shownSources(item);
    const body = answerText(item.a).split('\n').map((line) => `> ${line}`).join('\n');
    const from = sources.length ? `\n>\n> 来源：${sources.map((source) => `[${source.n}] ${sourceLink(source)}`).join('、')}` : '';
    const block = `\n\n> [!ai] AI：${item.q.replace(/\n/g, ' ')}\n${body}${from}\n`;
    const editor = view.editor;
    const line = Math.min(picked.line >= 0 ? picked.line : editor.getCursor('to').line, editor.lastLine());
    editor.replaceRange(block, { line, ch: editor.getLine(line).length });
    new Notice('已插入到选中段落下方');
  }

  private async continueInSidebar() {
    const items = this.items.filter((item) => !item.pending && !item.error);
    if (!items.length) return;
    const picked = this.picked;
    const first = items[0]!;
    const adopted = items.map((item, i) => ({
      q: i === 0 && picked ? `关于「${picked.text.slice(0, 80)}${picked.text.length > 80 ? '…' : ''}」：${first.q}` : item.q,
      a: item.a,
      current: item.current,
      model: item.model,
      modelId: item.modelId,
      sources: item.sources,
      texts: item.texts
    }));
    this.hidePanel();
    await this.plugin.openAsk();
    const leaf = this.plugin.app.workspace.getLeavesOfType(ASK_VIEW)[0];
    if (leaf?.view instanceof AskView) await leaf.view.adopt(adopted);
  }
}
