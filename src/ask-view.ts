import { Component, ItemView, Menu, Notice, WorkspaceLeaf, normalizePath } from 'obsidian';
import { message } from './backend';
import { INFER, verifyAnswer, type PinnedNote, type Source, type Turn } from './core';
import { modelPicker, renderAnswer, retryButtons, shownSources } from './answer';
import type AiNotesPlugin from './main';
import { newSession, type Session } from './sessions';
import { ensureFolder, inRoot, safeName, sourceLink, sourceTexts, stamp, today } from './store';

export const ASK_VIEW = 'eduaiot-ai-notes-ask';

interface Entry {
  q: string;
  a: string;
  current: string;
  model?: string;
  modelId?: string;
  sources: Source[];
  texts: Map<number, string>;
  error: string;
  pending: boolean;
}

function pad(value: number) {
  return String(value).padStart(2, '0');
}

function day(time: number) {
  const date = new Date(time);
  return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export class AskView extends ItemView {
  private entries: Entry[] = [];
  private session: Session = newSession();
  private messagesEl!: HTMLElement;
  private input!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  private modeEl!: HTMLElement;
  private currentEl!: HTMLElement;
  private useCurrent = true;
  private renderer = new Component();

  constructor(leaf: WorkspaceLeaf, private readonly plugin: AiNotesPlugin) {
    super(leaf);
  }

  getViewType() {
    return ASK_VIEW;
  }

  getDisplayText() {
    return 'AI 问答';
  }

  getIcon() {
    return 'message-circle';
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('eai-ask');
    const head = root.createDiv({ cls: 'eai-head' });
    head.createSpan({ cls: 'eai-link', text: 'AI 问答' });
    const buttons = head.createDiv({ cls: 'eai-actions' });
    buttons.createEl('button', { text: '新会话' }).onclick = () => this.startNew();
    buttons.createEl('button', { text: '历史' }).onclick = (event) => this.showHistory(event);
    const legend = root.createDiv({ cls: 'eai-legend' });
    legend.createSpan({ text: '只根据你的笔记回答。' });
    legend.createSpan({ cls: 'eai-quote', text: '「原话」' });
    legend.createSpan({ text: '已在笔记里核对，' });
    legend.createSpan({ cls: 'eai-unverified', text: '「原话」' });
    legend.createSpan({ text: '是原文里没找到的，' });
    legend.createSpan({ cls: 'eai-infer', text: 'AI 推断' });
    legend.createSpan({ text: '是笔记里没有、AI 补充的。' });
    this.messagesEl = root.createDiv({ cls: 'eai-messages' });
    const form = root.createDiv({ cls: 'eai-form' });
    this.currentEl = form.createEl('label', { cls: 'eai-current' });
    this.input = form.createEl('textarea', {
      cls: 'eai-textarea',
      attr: { placeholder: '问点什么，比如：我存过哪些讲短视频脚本的内容？（Enter 发送，Shift+Enter 换行）' }
    });
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void this.send();
      }
    });
    const footer = form.createDiv({ cls: 'eai-form-footer' });
    this.modeEl = footer.createDiv({ cls: 'eai-model-slot' });
    this.sendButton = footer.createEl('button', { cls: 'mod-cta', text: '发送' });
    this.sendButton.onclick = () => this.send();
    this.renderer.load();
    this.updateMode();
    this.render();
    await this.plugin.sessions.load();
    const last = this.plugin.sessions.all()[0];
    if (last && !this.entries.length) await this.openSession(last);
  }

  async onClose() {
    this.renderer.unload();
  }

  private busy() {
    if (!this.entries.some((entry) => entry.pending)) return false;
    new Notice('正在回答，请稍等');
    return true;
  }

  private startNew() {
    if (this.busy()) return;
    if (this.entries.length) {
      this.session = newSession();
      this.entries = [];
      this.render();
      this.updateMode();
    }
    this.input.focus();
  }

  private async openSession(session: Session) {
    this.session = session;
    this.entries = session.entries.map((entry) => ({ ...entry, texts: new Map(), pending: false }));
    this.render();
    this.updateMode();
    for (const entry of this.entries) entry.texts = await this.sourceTexts(entry.sources);
    if (this.session === session) this.render();
  }

  private showHistory(event: MouseEvent) {
    if (this.busy()) return;
    const menu = new Menu();
    const sessions = this.plugin.sessions.all();
    if (!sessions.length) menu.addItem((item) => item.setTitle('还没有历史会话').setDisabled(true));
    for (const session of sessions.slice(0, 30)) {
      menu.addItem((item) => item
        .setTitle(`${session.title || '未命名'} · ${day(session.updated)}`)
        .setChecked(session.id === this.session.id)
        .onClick(() => this.openSession(session)));
    }
    if (this.plugin.sessions.get(this.session.id)) {
      menu.addSeparator();
      menu.addItem((item) => item.setTitle('删除当前会话').setIcon('trash').onClick(async () => {
        await this.plugin.sessions.remove(this.session.id);
        const next = this.plugin.sessions.all()[0];
        if (next) await this.openSession(next);
        else {
          this.session = newSession();
          this.entries = [];
          this.render();
        }
      }));
    }
    menu.showAtMouseEvent(event);
  }

  private async persist() {
    const session = this.session;
    session.entries = this.entries
      .filter((entry) => !entry.pending)
      .map(({ q, a, current, sources, error, model, modelId }) => ({ q, a, current, sources, error, model, modelId }));
    if (!session.entries.length) return;
    session.title = session.title || session.entries[0].q.split('\n')[0].slice(0, 40);
    session.updated = Date.now();
    await this.plugin.sessions.put(session);
  }

  updateMode() {
    if (this.modeEl) {
      this.modeEl.empty();
      modelPicker(this.plugin, this.modeEl, this.session.model ?? '', (id) => {
        this.session.model = id === this.plugin.settings.chatModel ? undefined : id;
      });
    }
    if (!this.currentEl) return;
    this.currentEl.empty();
    const file = this.plugin.currentFile();
    if (!file) {
      this.currentEl.createSpan({ cls: 'eai-hint', text: '没有打开笔记，会在全部笔记里找。' });
      return;
    }
    const box = this.currentEl.createEl('input', { type: 'checkbox' });
    box.checked = this.useCurrent;
    box.onchange = () => {
      this.useCurrent = box.checked;
    };
    this.currentEl.createSpan({ text: '结合当前笔记：' });
    this.currentEl.createSpan({ cls: 'eai-link', text: file.basename });
  }

  private async pinned(): Promise<PinnedNote | null> {
    const file = this.plugin.currentFile();
    if (!this.useCurrent || !file) return null;
    return { path: file.path, text: await this.app.vault.cachedRead(file) };
  }

  focusInput(text?: string) {
    if (text) this.input.value = text;
    this.input.focus();
  }

  private async send() {
    const question = this.input.value.trim();
    if (!question || this.entries.some((entry) => entry.pending)) return;
    this.input.value = '';
    const history: Turn[] = this.entries.filter((entry) => !entry.pending && !entry.error).map((entry) => ({ q: entry.q, a: entry.a }));
    const modelId = this.session.model || this.plugin.settings.chatModel;
    const entry: Entry = { q: question, a: '', current: '', modelId, sources: [], texts: new Map(), error: '', pending: true };
    this.entries.push(entry);
    this.render();
    try {
      const pin = await this.pinned();
      entry.current = pin ? this.plugin.currentFile()?.basename ?? '' : '';
      this.render();
      const result = await this.plugin.backend.ask(question, history, pin, modelId);
      entry.model = result.model;
      entry.a = result.answer;
      entry.sources = result.sources;
      entry.texts = await this.sourceTexts(result.sources);
    } catch (error) {
      entry.error = message(error);
    }
    entry.pending = false;
    this.render();
    await this.persist();
  }

  private sourceTexts(sources: Source[]) {
    return sourceTexts(this.app, sources);
  }

  private async retry(entry: Entry, modelId: string) {
    if (this.entries.some((item) => item.pending)) return;
    this.session.model = modelId === this.plugin.settings.chatModel ? undefined : modelId;
    this.updateMode();
    const index = this.entries.indexOf(entry);
    const history: Turn[] = this.entries.slice(0, index).filter((item) => !item.error).map((item) => ({ q: item.q, a: item.a }));
    entry.pending = true;
    entry.error = '';
    entry.modelId = modelId;
    this.render();
    try {
      const pin = await this.pinned();
      const result = await this.plugin.backend.ask(entry.q, history, pin, modelId);
      entry.a = result.answer;
      entry.model = result.model;
      entry.sources = result.sources;
      entry.texts = await this.sourceTexts(result.sources);
    } catch (error) {
      entry.error = message(error);
    }
    entry.pending = false;
    this.render();
    await this.persist();
  }

  async adopt(items: { q: string; a: string; current: string; model?: string; modelId?: string; sources: Source[]; texts: Map<number, string> }[]) {
    if (this.entries.some((entry) => entry.pending)) return;
    this.entries.push(...items.map((item) => ({ ...item, error: '', pending: false })));
    this.render();
    await this.persist();
    this.input.focus();
  }

  private render() {
    this.renderer.unload();
    this.renderer = new Component();
    this.renderer.load();
    const list = this.messagesEl;
    list.empty();
    this.sendButton.disabled = this.entries.some((entry) => entry.pending);
    if (!this.entries.length) {
      list.createEl('p', { cls: 'eai-hint', text: '还没有提问。' });
      return;
    }
    for (const entry of this.entries) {
      const question = list.createDiv({ cls: 'eai-question' });
      question.createDiv({ text: entry.q });
      question.createDiv({ cls: 'eai-scope', text: entry.current ? `📌 以《${entry.current}》为主，其他笔记补充` : '🔍 在全部笔记里找' });
      const answer = list.createDiv({ cls: 'eai-answer' });
      if (entry.pending) {
        answer.createEl('p', { cls: 'eai-hint', text: '正在翻笔记…' });
        continue;
      }
      if (entry.error) {
        answer.createEl('p', { cls: 'eai-error', text: entry.error });
        retryButtons(this.plugin, answer, entry.modelId ?? '', (id) => void this.retry(entry, id));
        continue;
      }
      renderAnswer(this.plugin, answer, entry, this.renderer);
      if (entry.model) answer.createDiv({ cls: 'eai-meta', text: `由 ${entry.model} 回答` });
      const actions = answer.createDiv({ cls: 'eai-actions' });
      actions.createEl('button', { text: '存成笔记' }).onclick = () => this.save(entry);
      actions.createEl('button', { text: '复制' }).onclick = async () => {
        await navigator.clipboard.writeText(entry.a);
        new Notice('已复制');
      };
    }
    list.scrollTop = list.scrollHeight;
  }

  private async save(entry: Entry) {
    const name = safeName(entry.q, '问答');
    const vault = this.app.vault;
    await ensureFolder(this.app, inRoot('问答'));
    let path = normalizePath(`${inRoot('问答')}/${stamp()} ${name}.md`);
    for (let i = 2; vault.getAbstractFileByPath(path); i++) path = normalizePath(`${inRoot('问答')}/${stamp()} ${name}-${i}.md`);
    const answer = verifyAnswer(entry.a, entry.texts, (quote, ok, cite) => `「${quote}」${cite}${ok ? '' : '（原文里没找到）'}`).text;
    const quote = (text: string) => text.split('\n').map((line) => `> ${line}`).join('\n');
    const sources = shownSources(entry);
    const parts = [
      '---',
      `title: ${JSON.stringify(entry.q.split('\n')[0].slice(0, 80))}`,
      'type: 问答',
      'source: ai',
      `created: ${today()}`,
      '---',
      '',
      `> [!question] 问题\n${quote(entry.q)}`,
      '',
      `> [!ai] AI 根据你的笔记整理（「」是笔记原话，${INFER}是 AI 补充的）\n${quote(answer)}`
    ];
    if (sources.length) {
      parts.push('', '### 来源', '', ...sources.map((source) => `- [${source.n}] ${sourceLink(source)}`));
    }
    const file = await vault.create(path, `${parts.join('\n')}\n`);
    await this.app.workspace.getLeaf(true).openFile(file);
    new Notice('已存成笔记');
  }
}
