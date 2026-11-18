import { debounce, ItemView, Notice, setIcon, TFile, WorkspaceLeaf } from 'obsidian';
import { message } from './backend';
import { confirmDialog } from './confirm';
import type AiNotesPlugin from './main';
import type { Cut } from './core';
import { ALL, ROOT, RUN_LIMIT, type Health, type MapFolder, type Suggestion } from './organize';
import type { PlanFolder } from './core';

export const ORGANIZE_VIEW = 'eduaiot-ai-notes-organize';
const SHOW = 50;

function folderOf(path: string) {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
}

function isContentSuggestion(item: Suggestion) {
  return item.use.summary || item.use.tags || item.use.title || item.use.links || !!item.summary || item.tags.length > 0 || !!item.title || item.links.length > 0;
}

export class OrganizeView extends ItemView {
  private health: Health | null = null;
  private expanded: string | null = null;
  private stickyEl!: HTMLElement;
  private stickyBusy!: HTMLElement;
  private stickyLinks = new Map<string, HTMLAnchorElement>();
  private stickyBadge2!: HTMLElement;
  private stickyBadgeHealth!: HTMLElement;
  private mapChanged = 0;
  private healthIssues = 0;
  private scopeEl!: HTMLElement;
  private busyEl!: HTMLElement;
  private contentElBox!: HTMLElement;
  private contentHead!: HTMLElement;
  private listBody!: HTMLElement;
  private structureEl!: HTMLElement;
  private healthEl!: HTMLElement;
  private cutEl!: HTMLElement;
  private listOpen = false;
  private planOpen = false;
  private mapOpen: boolean | null = null;
  private onlyChanged = true;
  private structureStep: 0 | 1 | 2 | 3 = 0;
  private structureActive = false;
  private contentCount = 0;
  private readonly persist = debounce(() => {
    void this.plugin.organizer.persist();
    void this.renderStructure();
  }, 600, true);

  constructor(leaf: WorkspaceLeaf, private readonly plugin: AiNotesPlugin) {
    super(leaf);
  }

  getViewType() {
    return ORGANIZE_VIEW;
  }

  getDisplayText() {
    return '整理笔记';
  }

  getIcon() {
    return 'wand-sparkles';
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass('eai-organize');
    this.stickyEl = root.createDiv({ cls: 'eai-sticky is-hidden' });
    this.renderStickyNav();
    const head = root.createDiv({ cls: 'eai-page-head' });
    head.createEl('h4', { text: '易度笔记助手' });
    head.createEl('p', { cls: 'eai-hint', text: '先补笔记信息，再做分类（当然也可以不补）' });
    this.busyEl = root.createDiv({ cls: 'eai-busy' });
    this.scopeEl = root.createDiv({ cls: 'eai-mod eai-mod-compact' });
    this.scopeEl.id = 'eai-scope';
    const flow = root.createDiv({ cls: 'eai-flow-label' });
    flow.createSpan({ text: '整理流程' });
    flow.createSpan({ cls: 'eai-meta', text: '按顺序做，第 1 步可跳过' });
    this.contentElBox = root.createDiv({ cls: 'eai-mod' });
    this.contentElBox.id = 'eai-step1';
    this.contentHead = this.contentElBox.createDiv({ cls: 'eai-mod-head' });
    this.listBody = this.contentElBox.createDiv({ cls: 'eai-mod-body' });
    this.structureEl = root.createDiv({ cls: 'eai-mod' });
    this.structureEl.id = 'eai-step2';
    this.healthEl = root.createDiv({ cls: 'eai-mod eai-mod-compact' });
    this.healthEl.id = 'eai-health';
    this.cutEl = root.createEl('details', { cls: 'eai-mod eai-mod-danger eai-mod-compact' });
    this.cutEl.id = 'eai-cut';
    this.renderCut(this.cutEl);
    this.renderScope();
    this.renderContentHead();
    const scroller = (this.contentEl.closest('.view-content') as HTMLElement | null) ?? this.contentEl;
    this.registerDomEvent(scroller, 'scroll', () => this.updateSticky(scroller));
    await this.refresh();
  }

  private renderStickyNav() {
    this.stickyEl.empty();
    this.stickyLinks.clear();
    const nav = this.stickyEl.createDiv({ cls: 'eai-sticky-nav' });
    for (const [id, label] of [
      ['eai-scope', '范围'],
      ['eai-step1', '补全笔记信息'],
      ['eai-step2', '整理分类'],
      ['eai-health', '诊断'],
      ['eai-cut', '批量删除']
    ] as const) {
      const a = nav.createEl('a', { href: '#' });
      a.dataset.target = id;
      a.createSpan({ text: label });
      if (id === 'eai-step2') {
        this.stickyBadge2 = a.createSpan({ cls: 'eai-nbadge is-hidden' });
      }
      if (id === 'eai-health') {
        this.stickyBadgeHealth = a.createSpan({ cls: 'eai-nbadge is-amber is-hidden' });
      }
      a.onclick = (event) => {
        event.preventDefault();
        this.setStickyActive(id);
        this.contentEl.querySelector(`#${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      };
      this.stickyLinks.set(id, a);
    }
    this.stickyBusy = this.stickyEl.createDiv({ cls: 'eai-sticky-busy is-hidden' });
    this.refreshStickyBadges();
  }

  private setStickyActive(active: string) {
    for (const [id, link] of this.stickyLinks) {
      const on = id === active;
      link.toggleClass('is-active', on);
      if (on) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    }
  }

  private refreshStickyBadges() {
    if (this.stickyBadge2) {
      const show = this.mapChanged > 0;
      this.stickyBadge2.toggleClass('is-hidden', !show);
      this.stickyBadge2.setText(show ? `${this.mapChanged} 处变化` : '');
    }
    if (this.stickyBadgeHealth) {
      const show = this.healthIssues > 0;
      this.stickyBadgeHealth.toggleClass('is-hidden', !show);
      this.stickyBadgeHealth.setText(show ? String(this.healthIssues) : '');
    }
  }

  private updateSticky(scroller: HTMLElement) {
    const show = scroller.scrollTop > 48;
    this.stickyEl.toggleClass('is-hidden', !show);
    if (!show) return;
    const ids = ['eai-scope', 'eai-step1', 'eai-step2', 'eai-health', 'eai-cut'];
    const stickyH = Math.max(40, this.stickyEl.getBoundingClientRect().height);
    const top = scroller.getBoundingClientRect().top + stickyH + 12;
    let active = ids[0]!;
    for (const id of ids) {
      const el = this.contentEl.querySelector(`#${id}`);
      if (!(el instanceof HTMLElement)) continue;
      if (el.getBoundingClientRect().top <= top) active = id;
    }
    this.setStickyActive(active);
  }

  private setBusy(text: string | null) {
    this.contentEl.toggleClass('is-working', !!text);
    this.busyEl.toggleClass('is-on', !!text);
    this.busyEl.setText(text ?? '');
    this.stickyBusy.toggleClass('is-hidden', !text);
    this.stickyBusy.setText(text ?? '');
    if (text) {
      this.stickyEl.removeClass('is-hidden');
      this.busyEl.scrollIntoView({ block: 'nearest' });
    }
  }

  private modIcon(parent: HTMLElement, icon: string, tone: string) {
    const wrap = parent.createDiv({ cls: `eai-mod-ic ${tone}` });
    setIcon(wrap, icon);
    return wrap;
  }

  private confirm(heading: string, text: string, action?: string) {
    return confirmDialog(this.app, heading, text, action, this.containerEl);
  }

  private scopes(): [string, string][] {
    return [[ALL, '全部笔记（整个笔记库）'], [ROOT, '根目录下的笔记（不含子文件夹）'], ...this.plugin.organizer.folders().map((folder): [string, string] => [folder, folder])];
  }

  private inScope(path: string, scope = this.currentScope()): boolean {
    if (scope === ALL) return true;
    if (scope === ROOT) return !path.includes('/');
    return path === scope || path.startsWith(`${scope}/`);
  }

  private renderScope() {
    const box = this.scopeEl;
    box.empty();
    const head = box.createDiv({ cls: 'eai-mod-head' });
    this.modIcon(head, 'crosshair', 'is-slate');
    const info = head.createDiv({ cls: 'eai-mod-text' });
    info.createEl('h5', { text: '选择范围' });
    info.createEl('p', { cls: 'eai-hint', text: '下面所有操作只作用于这个范围' });
    const row = head.createDiv({ cls: 'eai-actions' });
    const select = row.createEl('select', { cls: 'dropdown' });
    const scopes = this.scopes();
    for (const [value, label] of scopes) select.createEl('option', { text: label, value });
    if (scopes.some(([value]) => value === this.plugin.settings.organizeFolder)) select.value = this.plugin.settings.organizeFolder;
    const count = this.plugin.organizer.filesIn(select.value).length;
    row.createSpan({ cls: 'eai-scope-count', text: `${count} 篇` });
    select.onchange = () => {
      this.plugin.settings.organizeFolder = select.value;
      void this.plugin.saveData(this.plugin.settings);
      this.expanded = null;
      if (this.health) this.renderHealth();
      void this.renderStructure();
      void this.renderList();
      this.renderScope();
    };
  }

  private renderContentHead() {
    const box = this.contentHead;
    box.empty();
    this.contentElBox.toggleClass('is-current', !this.structureActive);
    this.modIcon(box, 'sparkles', 'is-blue');
    const text = box.createDiv({ cls: 'eai-mod-text' });
    const title = text.createDiv({ cls: 'eai-mod-title-row' });
    const badge = title.createSpan({ cls: `eai-step-badge${this.structureActive ? '' : ' is-current'}` });
    badge.setText(this.structureActive ? '第 1 步' : this.contentCount ? '第 1 步 · 有建议' : '第 1 步 · 当前');
    title.createEl('h5', { text: '补全笔记信息' });
    title.createSpan({ cls: 'eai-tag', text: '可跳过' });
    text.createEl('p', { cls: 'eai-hint', text: '请补充笔记的摘要、标签、标题等相关信息。' });
    box.createDiv({ cls: 'eai-actions' }).createEl('button', {
      cls: 'mod-cta',
      text: this.contentCount ? '重新生成' : '生成内容建议'
    }).onclick = () => {
      const scope = this.currentScope();
      void this.run(this.plugin.organizer.notesIn(scope), this.scopeLabel(scope), scope);
    };
  }

  private renderCut(box: HTMLElement) {
    const settings = this.plugin.settings;
    box.empty();
    const summary = box.createEl('summary', { cls: 'eai-mod-head' });
    this.modIcon(summary, 'trash', 'is-red');
    const text = summary.createDiv({ cls: 'eai-mod-text' });
    const title = text.createDiv({ cls: 'eai-mod-title-row' });
    title.createEl('h5', { text: '批量删除段落' });
    title.createSpan({ cls: 'eai-tag is-danger', text: '危险操作' });
    text.createEl('p', { cls: 'eai-hint', text: '按开始行 / 结束行删掉一整段，先预览再确认；删除后需从回收站恢复' });
    const toggle = summary.createSpan({ cls: 'eai-toggle-txt' });
    toggle.createSpan({ cls: 'eai-when-closed', text: '展开' });
    toggle.createSpan({ cls: 'eai-when-open', text: '收起' });
    toggle.createSpan({ cls: 'eai-chev' });
    const body = box.createDiv({ cls: 'eai-mod-body' });
    body.createEl('p', { cls: 'eai-hint', text: '删掉从「开始行」到「结束行」的一整段（包括这两行）。只需填行里一定会出现的几个字，格式符号会被忽略。' });
    const form = body.createDiv({ cls: 'eai-cut-form' });
    const startField = form.createDiv();
    startField.createEl('label', { cls: 'eai-lbl', text: '开始行' });
    const start = startField.createEl('input', { type: 'text', value: '', attr: { placeholder: '例如：与我相关' } });
    const endField = form.createDiv();
    endField.createEl('label', { cls: 'eai-lbl', text: '结束行' });
    const end = endField.createEl('input', { type: 'text', value: '', attr: { placeholder: '例如：EduAIoT 第二大脑' } });
    const scopeField = form.createDiv();
    scopeField.createEl('label', { cls: 'eai-lbl', text: '在哪些笔记里找' });
    const scope = scopeField.createEl('select', { cls: 'dropdown' });
    const current = this.currentScope();
    const scopes = this.scopes();
    for (const [value, label] of scopes) {
      const count = this.plugin.organizer.filesIn(value).length;
      const text = value === current ? `当前范围：${label}（${count} 篇）` : label;
      scope.createEl('option', { text, value });
    }
    if (scopes.some(([value]) => value === settings.cutScope)) scope.value = settings.cutScope;
    else if (scopes.some(([value]) => value === current)) scope.value = current;
    const headingField = form.createDiv({ cls: 'eai-cut-check' });
    const headingLabel = headingField.createEl('label', { cls: 'eai-chk' });
    const heading = headingLabel.createEl('input', { type: 'checkbox' });
    heading.checked = settings.cutHeading;
    headingLabel.createSpan({ text: '开始行必须是标题' });
    const warn = body.createDiv({ cls: 'eai-cut-warn is-hidden' });
    warn.createSpan({ text: '你选的是整个笔记库，不只是上面的当前范围。请先预览，确认命中的每一篇都该删。' });
    const syncWarn = () => warn.toggleClass('is-hidden', scope.value !== ALL || current === ALL);
    syncWarn();
    scope.onchange = () => syncWarn();
    const actions = body.createDiv({ cls: 'eai-cut-actions' });
    const preview = actions.createEl('button', { text: '先预览' });
    actions.createSpan({ cls: 'eai-meta', text: '预览不会删除任何内容' });
    const result = body.createDiv({ cls: 'eai-cut-hits is-hidden' });
    const remember = () => {
      settings.cutStart = '';
      settings.cutEnd = '';
      settings.cutHeading = heading.checked;
      settings.cutScope = scope.value;
      void this.plugin.saveData(settings);
    };
    preview.onclick = async () => {
      remember();
      const startText = start.value.trim();
      const endText = end.value.trim();
      if (!startText || !endText) {
        new Notice('开始和结束都要填');
        return;
      }
      preview.setText('查找中…');
      preview.disabled = true;
      result.empty();
      result.addClass('is-hidden');
      try {
        const found = await this.plugin.organizer.previewCuts(settings.cutScope, startText, endText, settings.cutHeading);
        this.renderCutResult(result, found, startText, endText, settings.cutHeading);
      } finally {
        preview.setText('先预览');
        preview.disabled = false;
      }
    };
  }

  private renderCutResult(box: HTMLElement, found: { path: string; cuts: Cut[] }[], start: string, end: string, headingOnly: boolean) {
    box.empty();
    box.removeClass('is-hidden');
    if (!found.length) {
      box.createEl('p', { cls: 'eai-hint', text: '没有找到同时有开始行和结束行的笔记。可以试试少填几个字，或者取消「开始行必须是标题」。' });
      return;
    }
    const segments = found.reduce((sum, item) => sum + item.cuts.length, 0);
    const lines = found.reduce((sum, item) => sum + item.cuts.reduce((n, cut) => n + cut.lines, 0), 0);
    const title = box.createDiv({ cls: 'eai-cut-hits-title' });
    title.createEl('b', { text: `找到 ${segments} 段，分布在 ${found.length} 篇笔记里` });
    title.createSpan({ cls: 'eai-meta', text: `（共约 ${lines} 行）` });
    const list = box.createEl('ul', { cls: 'eai-cut-hits-list' });
    for (const item of found) {
      for (const cut of item.cuts) {
        const row = list.createEl('li');
        const link = row.createEl('a', { cls: 'eai-link', text: item.path.replace(/\.md$/i, ''), href: '#' });
        link.onclick = (event) => {
          event.preventDefault();
          void this.plugin.openNote(item.path, '', cut.from, true);
        };
        row.createSpan({ text: ` · 第 ${cut.from + 1}–${cut.to + 1} 行` });
      }
    }
    const actions = box.createDiv({ cls: 'eai-cut-actions' });
    const run = actions.createEl('button', { cls: 'eai-btn-danger-outline', text: `删除这 ${segments} 段…` });
    actions.createSpan({ cls: 'eai-meta', text: '下一步还会再确认一次' });
    run.onclick = async () => {
      if (!(await this.confirm(
        '确认删除？',
        `将在 ${found.length} 篇笔记中删除从「${start}」到「${end}」的段落（共 ${segments} 段）。删除后只能从回收站或历史版本恢复。`,
        `删除 ${segments} 段`
      ))) return;
      let notes = 0;
      let removedLines = 0;
      for (const item of found) {
        try {
          const removed = await this.plugin.organizer.cut(item.path, start, end, headingOnly);
          if (removed) {
            notes++;
            removedLines += removed;
          }
        } catch (error) {
          new Notice(`「${item.path}」删除失败：${message(error)}`, 8000);
        }
      }
      new Notice(`已从 ${notes} 篇笔记里删除 ${removedLines} 行`);
      const record = await this.plugin.organizer.writeRecord();
      if (record) await this.plugin.openNote(record.path, '', -1, true);
      box.empty();
      box.createSpan({ cls: 'eai-tag is-ok', text: `已删除 ${segments} 段` });
      await this.refresh();
    };
  }

  async refresh() {
    this.renderScope();
    this.renderContentHead();
    this.healthEl.empty();
    this.healthEl.createEl('p', { cls: 'eai-hint', text: '正在诊断…' });
    try {
      this.health = await this.plugin.organizer.health();
      this.renderHealth();
    } catch (error) {
      this.healthEl.empty();
      this.healthEl.createEl('p', { cls: 'eai-error', text: message(error) });
    }
    await this.renderList();
    await this.renderStructure();
  }

  private link(parent: HTMLElement, path: string) {
    const row = parent.createDiv();
    const link = row.createEl('a', { cls: 'eai-link', text: path.replace(/\.md$/i, ''), href: '#' });
    link.onclick = (event) => {
      event.preventDefault();
      void this.plugin.openNote(path, '', -1, true);
    };
  }

  private renderHealth() {
    const full = this.health!;
    const scope = this.currentScope();
    const recent = full.recent.filter((path) => this.inScope(path, scope));
    const untagged = full.untagged.filter((path) => this.inScope(path, scope));
    const orphans = full.orphans.filter((path) => this.inScope(path, scope));
    const poor = full.poor.filter((path) => this.inScope(path, scope));
    const empty = full.empty.filter((path) => this.inScope(path, scope));
    const duplicates = full.duplicates.filter((group) => group.some((path) => this.inScope(path, scope)));
    const emptyFolders = full.emptyFolders.filter((path) => this.inScope(path, scope));
    const total = this.plugin.organizer.filesIn(scope).length;
    const issues = [
      recent.length > 0,
      untagged.length > 0,
      orphans.length > 0,
      poor.length > 0,
      empty.length > 0,
      duplicates.length > 0,
      emptyFolders.length > 0
    ].filter(Boolean).length;
    this.healthIssues = issues;
    this.refreshStickyBadges();
    const box = this.healthEl;
    box.empty();
    const head = box.createDiv({ cls: 'eai-mod-head' });
    this.modIcon(head, 'activity', 'is-teal');
    const info = head.createDiv({ cls: 'eai-mod-text' });
    info.createEl('h5', { text: '笔记诊断' });
    info.createEl('p', { cls: 'eai-hint', text: `${this.scopeLabel(scope)} · 共 ${total} 篇` });
    if (issues) head.createSpan({ cls: 'eai-tag is-warn', text: `${issues} 项待处理` });
    else head.createSpan({ cls: 'eai-tag is-ok', text: '暂无问题' });
    const body = box.createDiv({ cls: 'eai-mod-body' });
    const grid = body.createDiv({ cls: 'eai-stat-grid' });
    const card = (key: string, label: string, count: number, canRun: boolean, danger = false) => {
      const item = grid.createDiv({ cls: count ? `eai-stat is-issue` : 'eai-stat is-zero' });
      const top = item.createDiv({ cls: 'eai-stat-top' });
      top.createSpan({ cls: 'eai-stat-n', text: String(count) });
      top.createSpan({ text: label });
      if (!count) return;
      const actions = item.createDiv({ cls: 'eai-actions eai-stat-acts' });
      actions.createEl('button', { text: this.expanded === key ? '收起' : '查看' }).onclick = () => {
        this.expanded = this.expanded === key ? null : key;
        this.renderHealth();
      };
      if (canRun) actions.createEl('button', { text: '补全这些' }).onclick = () => this.run(
        key === 'recent' ? recent : key === 'untagged' ? untagged : key === 'orphans' ? orphans : poor,
        label,
        scope
      );
      if (danger) actions.createEl('button', { cls: 'mod-warning', text: '全部删除' }).onclick = async () => {
        if (!(await this.confirm('删除空文件夹', `删除这 ${emptyFolders.length} 个空文件夹？${emptyFolders.slice(0, 8).join('、')}${emptyFolders.length > 8 ? ' 等' : ''}`, '删除'))) return;
        await this.act(() => this.plugin.organizer.removeFolders(emptyFolders), '已删除空文件夹');
      };
    };
    card('recent', '最近 7 天的新笔记', recent.length, true);
    card('untagged', '没有标签', untagged.length, true);
    card('orphans', '孤立笔记', orphans.length, true);
    card('poor', '标题看不出内容', poor.length, true);
    card('empty', '空笔记', empty.length, false);
    card('dup', '重复笔记', duplicates.length, false);
    card('folders', '空文件夹', emptyFolders.length, false, true);
    const lists: Record<string, string[]> = { recent, untagged, orphans, poor, empty };
    if (this.expanded === 'folders') {
      const list = body.createDiv({ cls: 'eai-sources' });
      for (const path of emptyFolders) list.createDiv({ text: `📁 ${path}` });
    } else if (this.expanded && this.expanded !== 'dup') {
      const list = body.createDiv({ cls: 'eai-sources' });
      const paths = lists[this.expanded] ?? [];
      paths.slice(0, SHOW).forEach((path) => this.link(list, path));
      if (paths.length > SHOW) list.createDiv({ cls: 'eai-meta', text: `……还有 ${paths.length - SHOW} 篇` });
    }
    if (this.expanded === 'dup') {
      const list = body.createDiv();
      list.createEl('p', { cls: 'eai-hint', text: '选一篇保留。其他进回收站；原来点到它们的链接会改指这篇。合并会把其他篇的正文和标签接到这篇后面（相同正文不重复贴）。' });
      duplicates.slice(0, SHOW).forEach((group, i) => this.renderDuplicate(list, group, i));
    }
  }

  private async runStructure() {
    if (this.plugin.organizer.running) {
      new Notice('正在处理，请稍等');
      return;
    }
    if (!this.plugin.local.chatReady()) {
      new Notice('还没有设置好对话模型，请在插件设置里填写 API key');
      return;
    }
    const scope = this.currentScope();
    const count = Math.min(this.plugin.organizer.notesIn(scope).length, RUN_LIMIT);
    if (!count) {
      new Notice('这个范围里没有可以整理的笔记');
      return;
    }
    const scopeText = scope === ALL || scope === ROOT
      ? 'AI 会设计一套文件夹结构，再把笔记分进去。'
      : `AI 会只在「${scope}」里设计子分类，再把笔记分进去。`;
    const missing = this.plugin.organizer.notesIn(scope).filter((path) => {
      const file = this.app.vault.getFileByPath(path);
      const summary = file ? this.app.metadataCache.getFileCache(file)?.frontmatter?.summary : undefined;
      return typeof summary !== 'string' || !summary.trim();
    }).length;
    const tip = missing > 0
      ? `\n\n当前约有 ${Math.min(missing, count)} 篇还没有摘要。建议先做①生成并应用内容建议，分类会更准；也可以直接继续。`
      : '';
    if (!(await this.confirm(
      '整理文件夹',
      `${scopeText}大约先调用 1 次设计分类，再调用约 ${Math.ceil(count / 5)} 次分配笔记。只会生成预览，确认前不改库。${tip}`,
      missing > 0 ? '仍要继续' : '开始整理'
    ))) return;

    this.structureStep = 1;
    this.planOpen = false;
    this.setBusy('① 正在设计文件夹结构…');
    this.structureEl.scrollIntoView({ block: 'nearest' });
    try {
      await this.plugin.organizer.generatePlan(scope);
      this.structureStep = 2;
      this.setBusy(`② 正在把笔记分进分类：0/${count}…`);
      const result = await this.plugin.organizer.classify((done, total) => {
        this.setBusy(done < total ? `② 正在把笔记分进分类：${done}/${total}…` : '② 正在整理分类结果…');
      });
      this.structureStep = 3;
      this.mapOpen = true;
      new Notice(`结构已就绪：${result.total} 篇里有 ${result.moved} 篇要换位置，请在预览里确认`);
    } catch (error) {
      new Notice(`整理失败：${message(error)}`, 8000);
      this.structureStep = (await this.plugin.organizer.plan()) ? 3 : 0;
    }
    this.setBusy(null);
    await this.renderStructure();
    this.structureEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  private async renderStructure() {
    const box = this.structureEl;
    box.empty();
    const scope = this.currentScope();
    const plan = await this.plugin.organizer.plan();
    const planScope = await this.plugin.organizer.planScope();
    const map = await this.plugin.organizer.map(scope);
    const active = !!plan || map.changed > 0 || this.structureStep > 0;
    this.structureActive = active;
    this.mapChanged = map.changed;
    this.refreshStickyBadges();
    box.toggleClass('is-current', active);
    this.renderContentHead();

    const head = box.createDiv({ cls: 'eai-mod-head' });
    this.modIcon(head, 'folder', 'is-violet');
    const info = head.createDiv({ cls: 'eai-mod-text' });
    const title = info.createDiv({ cls: 'eai-mod-title-row' });
    title.createSpan({ cls: `eai-step-badge${active ? ' is-current' : ''}`, text: active ? '第 2 步 · 当前' : '第 2 步' });
    title.createEl('h5', { text: '整理分类' });
    info.createEl('p', { cls: 'eai-hint', text: '根据笔记设计子文件夹，先预览，确认后才会移动。' });
    const actions = head.createDiv({ cls: 'eai-actions' });
    if (active && map.changed) {
      actions.createEl('button', { text: '放弃' }).onclick = async () => {
        if (!(await this.confirm('放弃整理文件夹', '清空分类方案，并去掉本范围里的搬家预览。内容建议会保留。', '放弃'))) return;
        await this.plugin.organizer.setPlan(null);
        await this.plugin.organizer.clearFolderMoves(scope);
        this.structureStep = 0;
        this.planOpen = false;
        this.mapOpen = null;
        await this.renderStructure();
        await this.renderList();
      };
      actions.createEl('button', { cls: 'mod-cta', text: `确认执行（${map.changed} 处）` }).onclick = async () => {
        if (!(await this.confirm('确认执行', `将按预览新建文件夹，并移动/改名本范围有变化的笔记（约 ${map.changed} 篇）。其他笔记里的链接会自动更新。`, '全部执行'))) return;
        await this.execute(true);
      };
    } else {
      actions.createEl('button', { cls: 'mod-cta', text: '整理文件夹' }).onclick = () => this.runStructure();
      if (active) {
        actions.createEl('button', { text: '放弃' }).onclick = async () => {
          if (!(await this.confirm('放弃整理文件夹', '清空分类方案，并去掉本范围里的搬家预览。内容建议会保留。', '放弃'))) return;
          await this.plugin.organizer.setPlan(null);
          await this.plugin.organizer.clearFolderMoves(scope);
          this.structureStep = 0;
          this.planOpen = false;
          this.mapOpen = null;
          await this.renderStructure();
          await this.renderList();
        };
      }
    }
    if (active && plan?.some((folder) => folder.from.some((from) => from !== folder.path))) {
      actions.createEl('button', { text: '只执行改名合并' }).onclick = () => this.runPlan();
    }

    const body = box.createDiv({ cls: 'eai-mod-body' });
    if (!active) {
      body.addClass('is-hidden');
      return;
    }

    const progress = body.createDiv({ cls: 'eai-progress' });
    progress.createDiv({ cls: 'eai-progress-label', text: '当前进度' });
    const steps = progress.createDiv({ cls: 'eai-steps' });
    const current =
      this.structureStep === 1 ? 1
        : this.structureStep === 2 ? 2
          : 3;
    for (const [i, label] of ['设计分类', '分配笔记', '预览确认', '保存到库'].entries()) {
      const n = i + 1;
      const state = n < current ? 'is-done' : n === current ? 'is-current' : 'is-todo';
      const el = steps.createDiv({ cls: `eai-step ${state}` });
      const mark = el.createDiv({ cls: 'eai-step-mark' });
      mark.setText(n < current ? '✓' : String(n));
      el.createDiv({ cls: 'eai-step-title', text: label });
    }

    if (plan && planScope !== scope) {
      body.createEl('p', { cls: 'eai-warn', text: `当前方案是按「${this.scopeLabel(planScope)}」做的，上面选的是「${this.scopeLabel(scope)}」。要按新范围重做，再点「整理文件夹」。` });
    }

    if (plan) {
      const fold = body.createEl('details', { cls: 'eai-fold' });
      fold.open = this.planOpen;
      fold.ontoggle = () => {
        this.planOpen = fold.open;
      };
      const summary = fold.createEl('summary', { cls: 'eai-fold-summary' });
      summary.createSpan({ text: `分类内容（${plan.length}）` });
      if (!fold.open) summary.createSpan({ cls: 'eai-meta', text: ' · 点击展开' });
      await this.renderPlanEditor(fold.createDiv({ cls: 'eai-fold-body' }), plan);
    }

    await this.renderMap(body, map);
  }

  private async renderPlanEditor(parent: HTMLElement, plan: PlanFolder[]) {
    const box = parent.createDiv({ cls: 'eai-plan-edit' });
    const locked = this.plugin.organizer.locked();
    if (locked.length) box.createEl('p', { cls: 'eai-hint', text: `受保护的文件夹：${locked.join('、')}` });
    const existing = new Set(this.plugin.organizer.folders());
    const save = debounce(async () => {
      await this.plugin.organizer.setPlan(plan);
      await this.renderStructure();
    }, 600, true);
    plan.forEach((folder, i) => {
      const row = box.createDiv({ cls: 'eai-plan-row' });
      const input = row.createEl('input', { type: 'text', value: folder.path, attr: { placeholder: '文件夹路径，比如 02-课程/编程' } });
      input.oninput = () => {
        folder.path = input.value;
        save();
      };
      const moved = folder.from.filter((from) => from !== folder.path);
      const badge = !folder.from.length
        ? existing.has(folder.path) ? '保留' : '新建'
        : moved.length > 1 || (moved.length && folder.from.includes(folder.path)) ? `合并：${folder.from.join('、')}` : moved.length ? `改名：原 ${moved[0]}` : '保留';
      const tag = row.createSpan({ cls: `eai-badge${badge === '新建' ? ' is-new' : badge === '保留' ? '' : ' is-change'}`, text: badge });
      tag.title = badge;
      row.createSpan({ cls: 'eai-meta eai-plan-desc', text: folder.desc });
      row.createEl('button', { text: '×' }).onclick = async () => {
        plan.splice(i, 1);
        await this.plugin.organizer.setPlan(plan);
        await this.renderStructure();
      };
    });
    box.createEl('button', { text: '加一个文件夹' }).onclick = async () => {
      plan.push({ path: '新分类', from: [], desc: '' });
      await this.plugin.organizer.setPlan(plan);
      await this.renderStructure();
    };
  }

  private async runPlan() {
    const plan = (await this.plugin.organizer.plan()) ?? [];
    const existing = new Set(this.plugin.organizer.folders());
    const created = plan.filter((folder) => !existing.has(folder.path)).length;
    const moved = plan.reduce((sum, folder) => sum + folder.from.filter((from) => from !== folder.path).length, 0);
    if (!(await this.confirm('执行分类方案', `将新建 ${created} 个文件夹，把 ${moved} 个文件夹的内容移到新位置，其他笔记里的链接会自动更新。执行后会生成一篇整理记录。`, '执行'))) return;
    await this.execute(false);
  }

  private async execute(withSuggestions: boolean) {
    this.setBusy(withSuggestions ? '正在按预览执行…' : '正在执行文件夹改名和合并…');
    let changes = 0;
    try {
      changes += await this.plugin.organizer.applyPlan();
      if (withSuggestions) {
        this.setBusy('正在移动和改名…');
        const scope = this.currentScope();
        for (const item of [...(await this.plugin.organizer.suggestions())]) {
          if (!this.inScope(item.path, scope)) continue;
          if (!item.use.folder && !item.use.title) continue;
          const onlyStructure = { ...item, use: { ...item.use, summary: false, tags: false, links: false } };
          try {
            await this.plugin.organizer.apply(onlyStructure);
            changes++;
          } catch (error) {
            new Notice(`「${item.path}」整理失败：${message(error)}`, 8000);
          }
        }
      }
    } catch (error) {
      new Notice(`整理失败：${message(error)}`, 8000);
    }
    this.setBusy(null);
    this.structureStep = 0;
    this.mapOpen = null;
    const record = await this.plugin.organizer.writeRecord();
    new Notice(changes ? `整理完成，改动 ${changes} 处` : '没有需要改动的');
    if (record) await this.plugin.openNote(record.path, '', -1, true);
    await this.refresh();
  }

  private async renderMap(parent: HTMLElement, map: MapFolder) {
    const scope = this.currentScope();
    const fold = parent.createEl('details', { cls: 'eai-fold' });
    fold.open = this.mapOpen ?? map.changed > 0;
    fold.ontoggle = () => {
      this.mapOpen = fold.open;
    };
    const summary = fold.createEl('summary', { cls: 'eai-fold-summary' });
    summary.createSpan({ text: `执行预览（${this.scopeLabel(scope)}）：${map.changed} 处变化` });
    if (map.changed) summary.createSpan({ cls: 'eai-badge is-new', text: '尚未写入库' });
    if (!fold.open) summary.createSpan({ cls: 'eai-meta', text: map.changed ? ' · 点击展开' : ' · 暂无位置变化' });
    const body = fold.createDiv({ cls: 'eai-fold-body' });
    body.createEl('p', {
      cls: 'eai-hint',
      text: '还没真正移动。🆕 将新建，蓝色是会挪走或改名的笔记。'
    });
    const tools = body.createDiv({ cls: 'eai-actions' });
    const toggle = tools.createEl('label', { cls: 'eai-current' });
    const box2 = toggle.createEl('input', { type: 'checkbox' });
    box2.checked = this.onlyChanged;
    box2.onchange = () => {
      this.onlyChanged = box2.checked;
      void this.renderStructure();
    };
    toggle.createSpan({ text: '只看有变化的' });
    const logged = await this.plugin.organizer.logSize();
    if (logged) {
      tools.createEl('button', { text: `生成整理记录（${logged} 处）` }).onclick = async () => {
        const record = await this.plugin.organizer.writeRecord();
        if (record) await this.plugin.openNote(record.path, '', -1, true);
        await this.renderStructure();
      };
    }
    const tree = body.createDiv({ cls: 'eai-tree-root' });
    this.renderTree(tree, map, 0);
    if (!tree.childElementCount) tree.createEl('p', { cls: 'eai-hint', text: '没有要挪的笔记。可改分类名后重做。' });
  }

  private renderTree(parent: HTMLElement, folder: MapFolder, depth: number) {
    for (const child of folder.folders) {
      if (this.onlyChanged && !child.changed && !child.isNew && !child.was.length) continue;
      const details = parent.createEl('details', { cls: 'eai-tree' });
      details.open = depth === 0 || child.changed > 0 || child.isNew;
      const summary = details.createEl('summary');
      summary.createSpan({ text: `${child.isNew ? '🆕' : '📁'} ${child.name}` });
      summary.createSpan({ cls: 'eai-meta', text: ` ${child.total} 篇${child.changed ? `，${child.changed} 处变化` : ''}` });
      if (child.was.length) summary.createSpan({ cls: 'eai-badge is-change', text: `原：${child.was.join('、')}` });
      this.renderTree(details.createDiv({ cls: 'eai-tree-body' }), child, depth + 1);
    }
    for (const note of folder.notes) {
      const changed = note.moved || note.renamed;
      if (this.onlyChanged && !changed) continue;
      const row = parent.createDiv({ cls: `eai-tree-note${changed ? ' is-changed' : ''}` });
      const link = row.createEl('a', { text: `📄 ${note.to.split('/').pop()!.replace(/\.md$/i, '')}`, href: '#' });
      link.onclick = (event) => {
        event.preventDefault();
        void this.plugin.openNote(note.from, '', -1, true);
      };
      if (note.moved) row.createSpan({ cls: 'eai-meta', text: ` ← 从 ${folderOf(note.from) || '根目录'} 移来` });
      if (note.renamed) row.createSpan({ cls: 'eai-meta', text: ` · 原名 ${note.from.split('/').pop()!.replace(/\.md$/i, '')}` });
    }
  }

  private renderDuplicate(parent: HTMLElement, group: string[], index: number) {
    const card = parent.createDiv({ cls: 'eai-card' });
    card.createDiv({ cls: 'eai-meta', text: `第 ${index + 1} 组，${group.length} 篇` });
    for (const path of group) {
      const file = this.app.vault.getAbstractFileByPath(path);
      const row = card.createDiv({ cls: 'eai-dup-row' });
      const info = row.createDiv({ cls: 'eai-pick-text' });
      this.link(info, path);
      if (file instanceof TFile) info.createDiv({ cls: 'eai-meta', text: `${new Date(file.stat.mtime).toLocaleString('zh-CN')} 修改 · ${file.stat.size} 字节` });
      const actions = row.createDiv({ cls: 'eai-actions' });
      const others = group.filter((item) => item !== path).map((item) => `《${item.split('/').pop()!.replace(/\.md$/i, '')}》`).join('、');
      const name = path.split('/').pop()!.replace(/\.md$/i, '');
      actions.createEl('button', { text: '保留这篇，删除其他' }).onclick = async () => {
        if (!(await this.confirm('删除重复笔记', `保留《${name}》，把 ${others} 移到回收站？`, '删除其他'))) return;
        await this.act(() => this.plugin.organizer.keepOnly(path, group), '已删除重复笔记');
      };
      actions.createEl('button', { text: '合并到这篇' }).onclick = async () => {
        if (!(await this.confirm('合并重复笔记', `把 ${others} 的正文和标签追加到《${name}》末尾，然后把它们移到回收站？`, '合并'))) return;
        await this.act(() => this.plugin.organizer.merge(path, group), '已合并');
      };
    }
  }

  private async act(run: () => Promise<void>, done: string) {
    try {
      await run();
      new Notice(done);
    } catch (error) {
      new Notice(`操作失败：${message(error)}`, 8000);
    }
    await this.refresh();
  }

  private currentScope(): string {
    const value = this.plugin.settings.organizeFolder;
    return this.scopes().some(([scope]) => scope === value) ? value : ALL;
  }

  private scopeLabel(scope: string): string {
    return this.scopes().find(([value]) => value === scope)?.[1] ?? scope;
  }

  private async run(paths: string[], label: string, scope: string) {
    if (this.plugin.organizer.running) {
      new Notice('正在生成内容建议，请稍等');
      return;
    }
    if (!this.plugin.local.chatReady()) {
      new Notice('还没有设置好对话模型，请在插件设置里填写 API key');
      return;
    }
    const usable = paths.filter((path) => this.plugin.local.engine.has(path));
    if (!usable.length) {
      new Notice('没有可以整理的笔记');
      return;
    }
    const count = Math.min(usable.length, RUN_LIMIT);
    const more = usable.length > count ? `（共 ${usable.length} 篇，这次先做前 ${count} 篇）` : '';
    const ok = await this.confirm(
      '生成内容建议',
      `为「${label}」的 ${count} 篇笔记生成摘要、标签、标题和相关笔记${more}，大约 ${Math.ceil(count / 2)} 次。不搬家；确认前不改笔记。`,
      '开始生成'
    );
    if (!ok) return;
    this.setBusy(`正在生成内容建议：0/${count}…`);
    this.contentElBox.scrollIntoView({ block: 'nearest' });
    try {
      const made = await this.plugin.organizer.generate(usable, (done, total) => {
        this.setBusy(done < total ? `正在生成内容建议：${done}/${total}…` : '正在整理生成结果…');
      }, scope, true);
      this.listOpen = true;
      new Notice(`生成了 ${made} 条内容建议，请在下面确认`);
    } catch (error) {
      new Notice(`生成失败：${message(error)}`, 8000);
    }
    this.setBusy(null);
    await this.renderList();
    this.plugin.refreshStatus();
  }

  private async renderList() {
    const box = this.listBody;
    box.empty();
    const all = (await this.plugin.organizer.suggestions()).filter(isContentSuggestion);
    const scope = this.currentScope();
    const list = all.filter((item) => this.inScope(item.path, scope));
    const other = all.length - list.length;
    this.contentCount = list.length;
    this.renderContentHead();
    const fold = box.createEl('details', { cls: 'eai-fold' });
    fold.open = this.listOpen;
    fold.ontoggle = () => {
      this.listOpen = fold.open;
    };
    const summary = fold.createEl('summary', { cls: 'eai-fold-summary eai-sugg-summary' });
    const title = other > 0 ? `内容建议（本范围 ${list.length} / 另有其它范围 ${other}）` : `内容建议（${list.length} 条）`;
    summary.createSpan({ text: title });
    if (list.length) summary.createSpan({ cls: 'eai-meta', text: this.listOpen ? '' : ' · 展开查看' });
    if (list.length) {
      const tools = summary.createDiv({ cls: 'eai-actions eai-sugg-tools' });
      tools.createEl('button', { cls: 'mod-cta', text: '应用全部勾选的' }).onclick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.applyAll(list);
      };
      tools.createEl('button', { text: '全部跳过' }).onclick = async (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!(await this.confirm('全部跳过', `跳过本范围这 ${list.length} 条内容建议？`, '全部跳过'))) return;
        for (const item of [...list]) await this.plugin.organizer.skip(item);
        await this.renderList();
      };
    }
    const body = fold.createDiv({ cls: 'eai-fold-body' });
    if (other > 0) {
      body.createEl('p', { cls: 'eai-hint', text: `另有 ${other} 条在别的范围，换上面的范围可看。` });
    }
    if (!list.length) {
      body.createEl('p', {
        cls: 'eai-hint',
        text: other > 0
          ? '当前范围没有。可换范围，或点「生成内容建议」/诊断里的「补全这些」。'
          : '还没有内容建议。'
      });
      return;
    }
    for (const item of list) this.renderCard(body, item);
  }

  private field(parent: HTMLElement, label: string, checked: boolean, onCheck: (value: boolean) => void) {
    const row = parent.createDiv({ cls: 'eai-field' });
    const box = row.createEl('input', { type: 'checkbox' });
    box.checked = checked;
    box.onchange = () => {
      onCheck(box.checked);
      this.persist();
    };
    row.createSpan({ cls: 'eai-field-label', text: label });
    return row.createDiv({ cls: 'eai-field-body' });
  }

  private renderCard(parent: HTMLElement, item: Suggestion) {
    const card = parent.createDiv({ cls: 'eai-card eai-suggest' });
    const name = item.path.split('/').pop()!.replace(/\.md$/i, '');
    const folder = folderOf(item.path) || '根目录';
    const title = card.createEl('a', { cls: 'eai-link', text: name, href: '#' });
    title.onclick = (event) => {
      event.preventDefault();
      void this.plugin.openNote(item.path, '', -1, true);
    };
    card.createSpan({ cls: 'eai-meta', text: `（${folder}）` });
    const text = (body: HTMLElement, value: string, placeholder: string, set: (value: string) => void) => {
      const input = body.createEl('input', { type: 'text', value, attr: { placeholder } });
      input.oninput = () => {
        set(input.value);
        this.persist();
      };
    };
    text(this.field(card, '摘要', item.use.summary, (v) => (item.use.summary = v)), item.summary, '一句话摘要', (v) => (item.summary = v));
    text(this.field(card, '加标签', item.use.tags, (v) => (item.use.tags = v)), item.tags.join(' '), '用空格分开', (v) => (item.tags = v.split(/[\s,，、]+/).filter(Boolean)));
    text(this.field(card, '改标题', item.use.title, (v) => (item.use.title = v)), item.title, '不改名就留空', (v) => (item.title = v));
    const links = this.field(card, '相关笔记', item.use.links, (v) => (item.use.links = v));
    const renderLinks = () => {
      links.empty();
      if (!item.links.length) links.createSpan({ cls: 'eai-meta', text: '没有' });
      for (const path of item.links) {
        const chip = links.createSpan({ cls: 'eai-chip', text: `${this.plugin.local.engine.title(path)} ×` });
        chip.title = '点一下去掉这条';
        chip.onclick = () => {
          item.links = item.links.filter((link) => link !== path);
          this.persist();
          renderLinks();
        };
      }
    };
    renderLinks();
    const actions = card.createDiv({ cls: 'eai-actions' });
    actions.createEl('button', { cls: 'mod-cta', text: '应用' }).onclick = async () => {
      try {
        const content = { ...item, use: { ...item.use, folder: false } };
        await this.plugin.organizer.apply(content);
        new Notice('已写入');
      } catch (error) {
        new Notice(`整理失败：${message(error)}`, 8000);
      }
      await this.renderList();
    };
    actions.createEl('button', { text: '跳过' }).onclick = async () => {
      await this.plugin.organizer.skip(item);
      await this.renderList();
    };
    actions.createEl('button', { cls: 'mod-warning', text: '删除' }).onclick = async () => {
      const name = item.path.split('/').pop()!.replace(/\.md$/i, '');
      if (!(await this.confirm('删除笔记', `把《${name}》移到回收站？之后可以在回收站里找回。`, '删除'))) return;
      await this.act(() => this.plugin.organizer.trash(item.path), '已移到回收站');
    };
  }

  private async applyAll(list: Suggestion[]) {
    const chosen = list.filter((item) => item.use.summary || item.use.tags || item.use.title || item.use.links);
    if (!chosen.length) {
      new Notice('没有勾选任何修改');
      return;
    }
    if (!(await this.confirm('应用内容建议', `把勾选的修改写入这 ${chosen.length} 篇笔记？不移动文件夹。`, '应用'))) return;
    let ok = 0;
    for (const item of chosen) {
      try {
        await this.plugin.organizer.apply({ ...item, use: { ...item.use, folder: false } });
        ok++;
      } catch (error) {
        new Notice(`「${item.path}」整理失败：${message(error)}`, 8000);
      }
    }
    new Notice(`已整理 ${ok} 篇笔记`);
    const record = await this.plugin.organizer.writeRecord();
    if (record) await this.plugin.openNote(record.path, '', -1, true);
    await this.refresh();
  }
}
