import { Component, FuzzySuggestModal, ItemView, Menu, Notice, TFolder, WorkspaceLeaf, normalizePath, type App, type TAbstractFile } from 'obsidian';
import { hasRefs, message, type Refs } from './backend';
import { INFER, verifyAnswer, type PinnedNote, type Source, type Turn } from './core';
import { modelPicker, renderAnswer, retryButtons, shownSources } from './answer';
import type AiNotesPlugin from './main';
import { newSession, type Session } from './sessions';
import { modelLabel, visionModel } from './settings';
import { ensureFolder, inRoot, safeName, sourceLink, sourceTexts, stamp, today } from './store';

export const ASK_VIEW = 'eduaiot-ai-notes-ask';
const MAX_IMAGES = 4;
const MAX_SIDE = 1600;
const IMAGE_QUESTION = '看看这张图片，结合我的笔记说说。';
const MAX_REFS = 8;

class RefSuggest extends FuzzySuggestModal<TAbstractFile> {
  constructor(app: App, private readonly pick: (item: TAbstractFile) => void) {
    super(app);
    this.setPlaceholder('搜索笔记或文件夹，回车选中');
  }

  getItems() {
    const folders = this.app.vault.getAllLoadedFiles().filter((item): item is TFolder => item instanceof TFolder && !item.isRoot());
    return [...folders, ...this.app.vault.getMarkdownFiles()];
  }

  getItemText(item: TAbstractFile) {
    return `${item instanceof TFolder ? '📁' : '📄'} ${item.path}`;
  }

  onChooseItem(item: TAbstractFile) {
    this.pick(item);
  }
}

const noRefs = (): Refs => ({ files: [], folders: [] });
const baseName = (path: string) => path.split('/').pop()?.replace(/\.md$/, '') ?? path;

interface Entry {
  q: string;
  a: string;
  current: string;
  model?: string;
  modelId?: string;
  images?: string[];
  imageCount?: number;
  refs?: Refs;
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

async function shrink(file: Blob): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = activeDocument.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.9);
}

const isImage = (file: File) => file.type.startsWith('image/');

export class AskView extends ItemView {
  private entries: Entry[] = [];
  private session: Session = newSession();
  private messagesEl!: HTMLElement;
  private input!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  private modeEl!: HTMLElement;
  private currentEl!: HTMLElement;
  private useCurrent = true;
  private images: string[] = [];
  private refs: Refs = noRefs();
  private attachEl!: HTMLElement;
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
    this.attachEl = form.createDiv({ cls: 'eai-attachments' });
    this.input = form.createEl('textarea', {
      cls: 'eai-textarea',
      attr: { placeholder: '问点什么，比如：我存过哪些讲短视频脚本的内容？（Enter 发送，Shift+Enter 换行，可以直接粘贴截图）' }
    });
    this.input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        void this.send();
      }
    });
    this.input.addEventListener('input', (event) => {
      const at = this.input.selectionStart;
      const typed = (event as Partial<InputEvent>).data;
      if ((typed !== '@' && typed !== '＠') || this.input.value[at - 1] !== typed) return;
      this.chooseRef(at - 1);
    });
    this.input.addEventListener('paste', (event) => {
      const files = Array.from(event.clipboardData?.files ?? []).filter(isImage);
      if (!files.length) return;
      event.preventDefault();
      void this.addImages(files);
    });
    form.addEventListener('dragover', (event) => {
      if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
    });
    form.addEventListener('drop', (event) => {
      const files = Array.from(event.dataTransfer?.files ?? []).filter(isImage);
      if (!files.length) return;
      event.preventDefault();
      void this.addImages(files);
    });
    const footer = form.createDiv({ cls: 'eai-form-footer' });
    this.modeEl = footer.createDiv({ cls: 'eai-model-slot' });
    const picker = footer.createEl('input', { type: 'file', attr: { accept: 'image/*', multiple: '' } });
    picker.hidden = true;
    picker.onchange = () => {
      void this.addImages(Array.from(picker.files ?? []).filter(isImage));
      picker.value = '';
    };
    const mention = footer.createEl('button', { text: '@', attr: { 'aria-label': '指定笔记或文件夹（也可以在输入框里输入 @）' } });
    mention.onclick = () => this.chooseRef(-1);
    const attach = footer.createEl('button', { text: '图片', attr: { 'aria-label': '添加图片，也可以直接粘贴截图或拖进来' } });
    attach.onclick = () => picker.click();
    this.sendButton = footer.createEl('button', { cls: 'mod-cta', text: '发送' });
    this.sendButton.onclick = () => this.send();
    this.renderer.load();
    this.updateMode();
    this.renderAttachments();
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
      .map(({ q, a, current, sources, error, model, modelId, imageCount, refs }) => ({ q, a, current, sources, error, model, modelId, imageCount, refs }));
    if (!session.entries.length) return;
    session.title = session.title || (session.entries[0]?.q.split('\n')[0] ?? '').slice(0, 40);
    session.updated = Date.now();
    await this.plugin.sessions.put(session);
  }

  updateMode() {
    if (this.modeEl) {
      this.modeEl.empty();
      modelPicker(this.plugin, this.modeEl, this.session.model ?? '', (id) => {
        this.session.model = id === this.plugin.defaultChat() ? undefined : id;
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

  private async addImages(files: File[]) {
    for (const file of files) {
      if (this.images.length >= MAX_IMAGES) {
        new Notice(`一次最多发 ${MAX_IMAGES} 张图片`);
        break;
      }
      try {
        this.images.push(await shrink(file));
      } catch {
        new Notice('这张图片读不出来');
      }
    }
    this.renderAttachments();
    this.input.focus();
  }

  private chooseRef(at: number) {
    new RefSuggest(this.app, (item) => {
      if (at >= 0 && /[@＠]/.test(this.input.value[at] ?? '')) this.input.value = this.input.value.slice(0, at) + this.input.value.slice(at + 1);
      const list = item instanceof TFolder ? this.refs.folders : this.refs.files;
      if (this.refs.files.length + this.refs.folders.length >= MAX_REFS) new Notice(`一次最多指定 ${MAX_REFS} 个笔记或文件夹`);
      else if (!list.includes(item.path)) list.push(item.path);
      this.renderAttachments();
      this.input.focus();
    }).open();
  }

  private renderAttachments() {
    this.attachEl.empty();
    this.attachEl.toggleClass('is-empty', !this.images.length && !hasRefs(this.refs));
    for (const [kind, icon] of [['folders', '📁'], ['files', '📄']] as const) {
      for (const path of this.refs[kind]) {
        const chip = this.attachEl.createDiv({ cls: 'eai-ref', attr: { title: path } });
        chip.createSpan({ text: `${icon} ${baseName(path)}` });
        const remove = chip.createEl('button', { text: '×', attr: { 'aria-label': '移除' } });
        remove.onclick = () => {
          this.refs[kind] = this.refs[kind].filter((item) => item !== path);
          this.renderAttachments();
        };
      }
    }
    this.images.forEach((url, i) => {
      const item = this.attachEl.createDiv({ cls: 'eai-attachment' });
      item.createEl('img', { attr: { src: url, alt: `图片 ${i + 1}` } });
      const remove = item.createEl('button', { text: '×', attr: { 'aria-label': '移除这张图片' } });
      remove.onclick = () => {
        this.images.splice(i, 1);
        this.renderAttachments();
      };
    });
  }

  private pickModel(modelId: string, images: string[]): string | null {
    if (!images.length) return modelId;
    const chosen = visionModel(this.plugin.settings, modelId);
    if (!chosen) {
      new Notice('现在设置的模型都不能看图片。请在插件设置里加一个能看图的模型（比如通义千问 qwen-vl-max、智谱 glm-4v-flash），并打开「支持图片」', 10000);
      return null;
    }
    if (chosen.id !== modelId) new Notice(`这轮带了图片，改用「${modelLabel(chosen)}」回答`);
    return chosen.id;
  }

  focusInput(text?: string) {
    if (text) this.input.value = text;
    this.input.focus();
  }

  private async send() {
    const images = [...this.images];
    const question = this.input.value.trim() || (images.length ? IMAGE_QUESTION : '');
    if (!question || this.entries.some((entry) => entry.pending)) return;
    const modelId = this.pickModel(this.session.model || this.plugin.defaultChat(), images);
    if (!modelId) return;
    const refs = this.refs;
    this.input.value = '';
    this.images = [];
    this.refs = noRefs();
    this.renderAttachments();
    const history: Turn[] = this.entries.filter((entry) => !entry.pending && !entry.error).map((entry) => ({ q: entry.q, a: entry.a }));
    const entry: Entry = { q: question, a: '', current: '', modelId, images, imageCount: images.length || undefined, refs: hasRefs(refs) ? refs : undefined, sources: [], texts: new Map(), error: '', pending: true };
    this.entries.push(entry);
    this.render();
    try {
      const pin = await this.pinned();
      entry.current = pin ? this.plugin.currentFile()?.basename ?? '' : '';
      this.render();
      const backend = images.length || hasRefs(refs) ? this.plugin.local : this.plugin.backend;
      const result = await backend.ask(question, history, pin, modelId, images, refs);
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

  private async retry(entry: Entry, picked: string) {
    if (this.entries.some((item) => item.pending)) return;
    const images = entry.images ?? [];
    const modelId = this.pickModel(picked, images);
    if (!modelId) return;
    this.session.model = modelId === this.plugin.defaultChat() ? undefined : modelId;
    this.updateMode();
    const index = this.entries.indexOf(entry);
    const history: Turn[] = this.entries.slice(0, index).filter((item) => !item.error).map((item) => ({ q: item.q, a: item.a }));
    entry.pending = true;
    entry.error = '';
    entry.modelId = modelId;
    this.render();
    try {
      const pin = await this.pinned();
      const refs = entry.refs ?? noRefs();
      const backend = images.length || hasRefs(refs) ? this.plugin.local : this.plugin.backend;
      const result = await backend.ask(entry.q, history, pin, modelId, images, refs);
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
      if (entry.images?.length) {
        const row = question.createDiv({ cls: 'eai-question-images' });
        for (const url of entry.images) row.createEl('img', { attr: { src: url, alt: '图片' } });
      } else if (entry.imageCount) {
        question.createDiv({ cls: 'eai-scope', text: `🖼 附了 ${entry.imageCount} 张图片` });
      }
      question.createDiv({ cls: 'eai-scope', text: this.scopeText(entry) });
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

  private scopeText(entry: Entry): string {
    const files = entry.refs?.files ?? [];
    const folders = entry.refs?.folders ?? [];
    const parts: string[] = [];
    if (entry.current) parts.push(`📌 《${entry.current}》`);
    if (files.length) parts.push(`📄 ${files.map((path) => `《${baseName(path)}》`).join('')}`);
    const others = folders.length ? `📁 只在「${folders.map(baseName).join('」「')}」里找其他笔记` : '其他笔记补充';
    if (!parts.length) return folders.length ? others : '🔍 在全部笔记里找';
    return `以 ${parts.join(' ')} 为主，${others}`;
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
      `title: ${JSON.stringify((entry.q.split('\n')[0] ?? '').slice(0, 80))}`,
      'type: 问答',
      'source: ai',
      `created: ${today()}`,
      '---',
      '',
      `> [!question] 问题\n${quote(entry.imageCount ? `${entry.q}\n（附了 ${entry.imageCount} 张图片）` : entry.q)}`,
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
