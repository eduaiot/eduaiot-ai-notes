import { debounce, FileSystemAdapter, MarkdownView, normalizePath, Notice, Plugin, requestUrl, TFile, TFolder, type WorkspaceLeaf } from 'obsidian';
import { ASK_VIEW, AskView } from './ask-view';
import type { Backend } from './backend';
import type { Http } from './core';
import { DesktopModel, type DesktopHello } from './desktop';
import { LocalBackend } from './local';
import { RELATED_VIEW, RelatedView } from './related-view';
import { GRAPH_VIEW, TopicGraphView } from './graph-view';
import { MarketModal, SkillMarket } from './market';
import { InterviewModal } from './interview';
import { Organizer } from './organize';
import { ORGANIZE_VIEW, OrganizeView } from './organize-view';
import { ProfileManager } from './profile';
import { Reviewer } from './review';
import { SearchModal } from './search-modal';
import { SelectionTools } from './selection';
import { SessionStore } from './sessions';
import { DESKTOP_MODEL, embedConfig, embedId, loadSettings, modelLabel, resolveModel, SettingTab, type Settings } from './settings';
import { SkillModal, SkillRunner } from './skills';
import { aiRoot, LEGACY_ROOT, setRoot } from './store';
import { TODAY_VIEW, TodayView } from './today-view';
import { TopicMapper } from './topics';

const DETECT_MS = 30_000;
const WEEKLY_MS = 60 * 60_000;
const WEEKLY_DELAY_MS = 2 * 60_000;

export default class AiNotesPlugin extends Plugin {
  settings!: Settings;
  local!: LocalBackend;
  desktop!: DesktopModel;
  backend!: Backend;
  desktopOn = false;
  readonly sessions = new SessionStore(this);
  readonly skills = new SkillRunner(this);
  readonly topics = new TopicMapper(this);
  readonly reviewer = new Reviewer(this);
  readonly profile = new ProfileManager(this);
  readonly organizer = new Organizer(this);
  readonly market = new SkillMarket(this);
  private statusBar!: HTMLElement;
  private lastFile: TFile | null = null;
  private detecting = false;
  private lastExclude = '';

  readonly http: Http = async (request) => {
    const response = await requestUrl({ ...request, throw: false });
    return { status: response.status, text: response.text };
  };

  private readonly applySettings = debounce(() => {
    void this.local.configChanged();
    if (this.settings.exclude !== this.lastExclude) {
      this.lastExclude = this.settings.exclude;
      void this.local.rescan();
    }
    void this.detect();
  }, 800, true);

  async onload() {
    this.settings = loadSettings(await this.loadData());
    setRoot(this.settings.root);
    this.lastExclude = this.settings.exclude;
    this.local = new LocalBackend(this);
    this.desktop = new DesktopModel(() => this.vaultPath(), () => this.settings.bridgeFile.trim());
    this.backend = this.local;
    this.desktopOn = this.settings.mode === 'desktop';

    this.registerView(ASK_VIEW, (leaf) => new AskView(leaf, this));
    this.registerView(RELATED_VIEW, (leaf) => new RelatedView(leaf, this));
    this.registerView(TODAY_VIEW, (leaf) => new TodayView(leaf, this));
    this.registerView(GRAPH_VIEW, (leaf) => new TopicGraphView(leaf, this));
    this.registerView(ORGANIZE_VIEW, (leaf) => new OrganizeView(leaf, this));
    this.addSettingTab(new SettingTab(this.app, this));

    this.addRibbonIcon('calendar-check', '今日笔记', () => this.openView(TODAY_VIEW));
    this.addRibbonIcon('search', '按意思搜笔记', () => new SearchModal(this.app, this).open());
    this.addRibbonIcon('message-circle', 'AI 问答', () => this.openAsk());
    this.addRibbonIcon('network', '相关笔记', () => this.openView(RELATED_VIEW));
    this.addCommand({ id: 'ask', name: '问我的笔记', callback: () => this.openAsk() });
    this.addCommand({ id: 'search', name: '按意思搜笔记', callback: () => new SearchModal(this.app, this).open() });
    this.addCommand({ id: 'related', name: '打开相关笔记侧栏', callback: () => this.openView(RELATED_VIEW) });
    this.addCommand({ id: 'today', name: '打开今日笔记（每日回顾）', callback: () => this.openView(TODAY_VIEW) });
    this.addCommand({ id: 'organize', name: '整理笔记（体检和 AI 整理建议）', callback: () => this.openOrganize() });
    this.addCommand({ id: 'skill', name: '运行技能…', callback: () => this.openSkills() });
    this.addCommand({ id: 'market', name: '打开技能市场', callback: () => this.openMarket() });
    this.addCommand({ id: 'weekly', name: '生成本周周报', callback: () => this.reviewer.weekly(true) });
    this.addCommand({ id: 'topics', name: '重新分析主题地图', callback: () => this.topics.build() });
    this.addCommand({ id: 'graph', name: '打开主题图谱', callback: () => this.topics.show() });
    this.addCommand({ id: 'inspire', name: '生成跨领域灵感', callback: () => this.topics.inspire() });
    this.addCommand({ id: 'profile-open', name: '打开我的画像', callback: () => this.profile.open() });
    this.addCommand({ id: 'profile-update', name: '从笔记里更新我的画像', callback: () => this.profile.update() });
    this.addCommand({ id: 'profile-interview', name: '回答几个问题，让 AI 更懂你', callback: () => new InterviewModal(this.app, this).open() });
    for (const name of ['爆款规律', '选题生成', '多篇合稿', '灵感卡']) {
      this.addCommand({ id: `skill-${name}`, name: `技能：${name}`, callback: () => this.skills.runByName(name, this.skillOptions()) });
    }
    this.addCommand({ id: 'install-skills', name: '恢复预置技能', callback: async () => new Notice(`已安装 ${await this.skills.installPresets()} 个预置技能`) });

    new SelectionTools(this).enable();

    this.statusBar = this.addStatusBarItem();
    this.statusBar.addClass('mod-clickable');
    this.statusBar.onclick = () => this.openView(TODAY_VIEW);

    this.registerEvent(this.app.workspace.on('editor-menu', (menu, editor) => {
      const selection = editor.getSelection().trim();
      menu.addItem((item) => item.setTitle('运行 AI 技能…').setIcon('sparkles').onClick(() => this.openSkills()));
      if (!selection) return;
      menu.addItem((item) => item.setTitle('问我的笔记').setIcon('message-circle').onClick(() => this.openAsk(selection)));
      menu.addItem((item) => item.setTitle('按意思搜笔记').setIcon('search').onClick(() => new SearchModal(this.app, this, selection).open()));
      menu.addItem((item) => item.setTitle('把选中的文字生成灵感卡').setIcon('lightbulb').onClick(() => this.skills.runByName('灵感卡', this.skillOptions())));
    }));
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (!(file instanceof TFile) || file.extension !== 'md') return;
      menu.addItem((item) => item.setTitle('运行 AI 技能…').setIcon('sparkles').onClick(() => this.openSkills(file)));
      menu.addItem((item) => item.setTitle('生成灵感卡').setIcon('lightbulb').onClick(() => this.skills.runByName('灵感卡', { file })));
    }));
    this.registerEvent(this.app.workspace.on('files-menu', (menu, files) => {
      const paths = files.filter((file): file is TFile => file instanceof TFile && file.extension === 'md').map((file) => file.path);
      if (paths.length < 2) return;
      menu.addItem((item) => item.setTitle(`把这 ${paths.length} 篇合成一篇草稿…`).setIcon('combine').onClick(() => this.skills.runByName('多篇合稿', { paths })));
    }));
    this.registerEvent(this.app.workspace.on('file-open', (file) => {
      if (file instanceof TFile && file.extension === 'md') this.lastFile = file;
      this.refresh();
    }));
    this.registerEvent(this.app.vault.on('create', (file) => this.local.touch(file)));
    this.registerEvent(this.app.vault.on('modify', (file) => {
      this.profile.invalidate(file.path);
      this.local.touch(file);
    }));
    this.registerEvent(this.app.vault.on('delete', (file) => this.local.drop(file.path)));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      this.local.drop(oldPath);
      this.local.touch(file);
      this.organizer.renamed(oldPath, file.path);
      if (this.lastFile?.path === oldPath && file instanceof TFile) this.lastFile = file;
    }));

    this.app.workspace.onLayoutReady(async () => {
      const active = this.app.workspace.getActiveFile();
      if (active?.extension === 'md') this.lastFile = active;
      if (!this.settings.rootChecked) await this.migrateRoot();
      void this.detect(true);
      if (!this.settings.welcomed) void this.welcome();
      window.setTimeout(() => void this.routine(), WEEKLY_DELAY_MS);
    });
    this.registerInterval(window.setInterval(() => void this.detect(), DETECT_MS));
    this.registerInterval(window.setInterval(() => void this.routine(), WEEKLY_MS));
  }

  private async migrateRoot() {
    this.settings.rootChecked = true;
    const legacy = this.app.vault.getAbstractFileByPath(LEGACY_ROOT);
    const ours = legacy instanceof TFolder && (await this.app.vault.adapter.exists(`${LEGACY_ROOT}/.state`) || legacy.children.some((child) => ['技能', '我的画像.md', '问答'].includes(child.name)));
    if (ours && LEGACY_ROOT !== aiRoot() && !this.app.vault.getAbstractFileByPath(aiRoot())) {
      try {
        await this.app.fileManager.renameFile(legacy, aiRoot());
        new Notice(`插件文件夹已从「${LEGACY_ROOT}」改名为「${aiRoot()}」，可以在插件设置里再改`, 10000);
      } catch (error) {
        new Notice(`插件文件夹改名失败：${error instanceof Error ? error.message : String(error)}`, 10000);
        this.settings.root = LEGACY_ROOT;
        setRoot(LEGACY_ROOT);
      }
    }
    await this.saveData(this.settings);
  }

  async renameRoot(name: string) {
    const next = normalizePath(name.trim());
    if (!next || /[\\:*?"<>|#^[\]]/.test(next)) throw new Error('文件夹名称不能为空，也不能包含 \\ : * ? " < > | # ^ [ ]');
    const current = aiRoot();
    if (next === current) return;
    if (this.app.vault.getAbstractFileByPath(next)) throw new Error(`「${next}」已经存在，换一个名字`);
    const folder = this.app.vault.getAbstractFileByPath(current);
    if (folder instanceof TFolder) await this.app.fileManager.renameFile(folder, next);
    this.settings.root = next;
    setRoot(next);
    await this.saveData(this.settings);
    new Notice(`插件文件夹已改名为「${next}」`);
  }

  private async welcome() {
    this.settings.welcomed = true;
    await this.saveData(this.settings);
    await this.local.start();
    await this.openOrganize();
    new Notice('欢迎使用易度助手！先给笔记做个体检，看看哪些需要整理。', 10000);
    new InterviewModal(this.app, this).open();
  }

  vectorsDone() {
    this.refreshToday();
    if (this.settings.autoProfile) void this.profile.weekly();
  }

  refreshToday() {
    for (const leaf of this.app.workspace.getLeavesOfType(TODAY_VIEW)) {
      if (leaf.view instanceof TodayView) void leaf.view.refresh();
    }
  }

  private async routine() {
    await this.reviewer.weekly();
    if (this.settings.autoProfile) await this.profile.weekly();
  }

  skillOptions(file: TFile | null = this.currentFile()) {
    const editor = this.app.workspace.activeEditor?.editor;
    return { file, selection: editor?.getSelection().trim() ?? '' };
  }

  async openSkills(file: TFile | null = this.currentFile()) {
    const options = this.skillOptions(file);
    new SkillModal(this.app, this, await this.skills.list(), options).open();
  }

  onunload() {
    void this.local.stop();
  }
  async saveSettings() {
    await this.saveData(this.settings);
    this.applySettings();
  }

  vaultPath(): string {
    const adapter = this.app.vault.adapter;
    if (adapter instanceof FileSystemAdapter) return adapter.getBasePath();
    throw new Error('只支持电脑版 Obsidian');
  }

  isActive(backend: Backend) {
    return this.backend === backend;
  }

  private helloInfo(): DesktopHello {
    const config = embedConfig(this.settings);
    return {
      vault: this.vaultPath(),
      configDir: this.app.vault.configDir,
      pluginDir: this.manifest.dir ?? '',
      exclude: this.settings.exclude.split('\n').map((line) => line.trim().replace(/^\/+|\/+$/g, '')).filter(Boolean),
      embed: config ? { id: embedId(this.settings), ...config } : null
    };
  }

  defaultChat(): string {
    return this.desktopOn ? DESKTOP_MODEL : this.settings.chatModel;
  }

  async detect(initial = false) {
    if (this.detecting) return;
    this.detecting = true;
    try {
      const mode = this.settings.mode;
      const online = mode === 'local' ? false : await this.desktop.probe();
      const next = mode === 'desktop' || (mode === 'auto' && online);
      const changed = next !== this.desktopOn;
      this.desktopOn = next;
      const indexing = this.desktop.indexing;
      if (next && online) await this.desktop.hello(this.helloInfo());
      else this.desktop.notes = null;
      if (indexing && !this.desktop.indexing) void this.local.resume();
      if (!this.local.started) void this.local.start().then(() => this.refresh(true));
      else this.local.kick();
      if (changed) {
        if (!initial) new Notice(next ? '已连接 EduAIoT 桌面版，AI 改用桌面版的模型' : '已改用插件里设置的模型');
        this.refresh(true);
      } else if (initial) {
        this.refresh(true);
      }
    } finally {
      this.detecting = false;
      this.refreshStatus();
    }
  }

  modeLabel(): string {
    if (this.desktopOn) {
      if (!this.desktop.model && this.settings.mode === 'desktop') return '桌面版未连接';
      return `桌面版${this.desktop.model ? ` · ${this.desktop.model}` : ''}`;
    }
    return `本插件 · ${modelLabel(resolveModel(this.settings, 'chat'))}`;
  }

  statusText(): string {
    const notes = this.desktop.indexing ? this.desktop.notes : null;
    const index = notes
      ? `笔记由桌面版检索，已读 ${notes.notes} 篇${notes.chunks ? `，按意思搜索已准备 ${Math.min(100, Math.floor((notes.embedded / Math.max(notes.chunks, 1)) * 100))}%${notes.error ? `（暂停：${notes.error}）` : ''}` : ''}`
      : `${this.local.statusText()}。${this.local.embedProgress()}`;
    if (this.desktopOn) {
      return this.desktop.model || this.settings.mode !== 'desktop'
        ? `当前：AI 用 EduAIoT 桌面版的模型${this.desktop.model ? ` ${this.desktop.model}` : ''}，${index}`
        : `当前：桌面版没有打开，${index}`;
    }
    return `当前：AI 用插件里设置的模型，${index}`;
  }

  refreshStatus() {
    if (!this.statusBar) return;
    const detail = this.desktopOn ? this.modeLabel() : this.local.statusText();
    const review = this.reviewer.pendingCount();
    this.statusBar.setText(`易度助手 · ${detail}${review ? ` · 回顾 ${review}` : ''}`);
    this.statusBar.title = this.statusText();
  }

  refresh(force = false) {
    for (const leaf of this.app.workspace.getLeavesOfType(RELATED_VIEW)) {
      if (leaf.view instanceof RelatedView) void leaf.view.refresh(force);
    }
    for (const leaf of this.app.workspace.getLeavesOfType(ASK_VIEW)) {
      if (leaf.view instanceof AskView) leaf.view.updateMode();
    }
  }

  currentFile(): TFile | null {
    const active = this.app.workspace.getActiveFile();
    if (active?.extension === 'md') return active;
    return this.lastFile && this.app.vault.getAbstractFileByPath(this.lastFile.path) ? this.lastFile : null;
  }

  async openNote(path: string, heading = '', line = -1, target: WorkspaceLeaf | boolean = false) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      new Notice('找不到这篇笔记，可能已经删除或改名');
      return;
    }
    if (line < 0 && heading && typeof target === 'boolean') {
      const link = !/[#|^[\]]/.test(heading) ? `${path}#${heading}` : path;
      await this.app.workspace.openLinkText(link, '', target);
      return;
    }
    const leaf = typeof target === 'boolean' ? this.app.workspace.getLeaf(target) : target;
    await leaf.openFile(file, line >= 0 ? { active: true, eState: { line } } : { active: true });
    if (line < 0) return;
    const view = leaf.view;
    if (!(view instanceof MarkdownView) || view.getMode() === 'preview') return;
    const editor = view.editor;
    const at = Math.min(line, editor.lastLine());
    const end = editor.getLine(at).length;
    editor.setSelection({ line: at, ch: 0 }, { line: at, ch: end });
    editor.scrollIntoView({ from: { line: at, ch: 0 }, to: { line: at, ch: end } }, true);
  }

  async openView(type: string) {
    let leaf = this.app.workspace.getLeavesOfType(type)[0];
    if (!leaf) {
      const right = this.app.workspace.getRightLeaf(false);
      if (!right) return;
      await right.setViewState({ type, active: true });
      leaf = right;
    }
    await this.app.workspace.revealLeaf(leaf);
    return leaf;
  }

  openMarket() {
    new MarketModal(this.app, this).open();
  }

  async openOrganize() {
    const existing = this.app.workspace.getLeavesOfType(ORGANIZE_VIEW)[0];
    if (existing) {
      await this.app.workspace.revealLeaf(existing);
      if (existing.view instanceof OrganizeView) await existing.view.refresh();
      return;
    }
    await this.app.workspace.getLeaf(true).setViewState({ type: ORGANIZE_VIEW, active: true });
  }

  async openGraph() {
    const existing = this.app.workspace.getLeavesOfType(GRAPH_VIEW)[0];
    if (existing) {
      await this.app.workspace.revealLeaf(existing);
      if (existing.view instanceof TopicGraphView) await existing.view.reload();
      return;
    }
    await this.app.workspace.getLeaf(true).setViewState({ type: GRAPH_VIEW, active: true });
  }

  async openAsk(text?: string) {
    const leaf = await this.openView(ASK_VIEW);
    if (leaf?.view instanceof AskView) leaf.view.focusInput(text);
  }
}
