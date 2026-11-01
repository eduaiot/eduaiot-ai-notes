import { debounce, ItemView, Notice, TFile, WorkspaceLeaf } from 'obsidian';
import { message } from './backend';
import { confirmDialog } from './confirm';
import type AiNotesPlugin from './main';
import type { Cut } from './core';
import { ALL, ROOT, RUN_LIMIT, type Health, type MapFolder, type Suggestion } from './organize';

export const ORGANIZE_VIEW = 'eduaiot-ai-notes-organize';
const SHOW = 50;

function folderOf(path: string) {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
}

export class OrganizeView extends ItemView {
  private health: Health | null = null;
  private expanded: string | null = null;
  private healthEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private listEl!: HTMLElement;
  private planEl!: HTMLElement;
  private mapEl!: HTMLElement;
  private onlyChanged = true;
  private readonly persist = debounce(() => {
    void this.plugin.organizer.persist();
    void this.renderMap();
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
    const head = root.createDiv({ cls: 'eai-head' });
    head.createEl('h4', { text: '整理笔记' });
    head.createEl('button', { text: '重新体检' }).onclick = () => this.refresh();
    root.createEl('p', {
      cls: 'eai-hint',
      text: 'AI 只给建议，你确认后才会写入。能写入的只有：属性里的摘要和标签、移动到别的文件夹、改标题、文末的「相关笔记」双链，正文不会被改动。'
    });
    this.healthEl = root.createDiv();
    this.planEl = root.createDiv({ cls: 'eai-section' });
    this.statusEl = root.createDiv({ cls: 'eai-meta' });
    this.listEl = root.createDiv({ cls: 'eai-section' });
    this.mapEl = root.createDiv({ cls: 'eai-section' });
    this.renderCut(root.createDiv({ cls: 'eai-section' }));
    await this.refresh();
  }

  private scopes(): [string, string][] {
    return [[ALL, '全部笔记（整个笔记库）'], [ROOT, '根目录下的笔记（不含子文件夹）'], ...this.plugin.organizer.folders().map((folder): [string, string] => [folder, folder])];
  }

  private renderCut(box: HTMLElement) {
    const settings = this.plugin.settings;
    box.createEl('h5', { text: '批量删除段落' });
    box.createEl('p', { cls: 'eai-hint', text: '删除每篇笔记里从「开始行」到「结束行」的一段，开始行和结束行本身也会删掉。只需要填这一行里一定会出现的几个字，比如结束行日期每篇都不同，就填「EduAIoT 第二大脑」；* _ 这类格式符号会自动忽略。先查找预览，确认后才删除。' });
    const form = box.createDiv({ cls: 'eai-cut-form' });
    const start = form.createEl('input', { type: 'text', value: settings.cutStart, attr: { placeholder: '开始行包含的文字，比如：与我相关' } });
    const end = form.createEl('input', { type: 'text', value: settings.cutEnd, attr: { placeholder: '结束行包含的文字，比如：EduAIoT 第二大脑' } });
    const options = box.createDiv({ cls: 'eai-actions eai-folder-run' });
    const label = options.createEl('label', { cls: 'eai-current' });
    const heading = label.createEl('input', { type: 'checkbox' });
    heading.checked = settings.cutHeading;
    label.createSpan({ text: '开始行必须是标题' });
    const scope = options.createEl('select', { cls: 'dropdown' });
    const scopes = this.scopes();
    for (const [value, text] of scopes) scope.createEl('option', { text, value });
    if (scopes.some(([value]) => value === settings.cutScope)) scope.value = settings.cutScope;
    const result = box.createDiv();
    const remember = () => {
      settings.cutStart = start.value.trim();
      settings.cutEnd = end.value.trim();
      settings.cutHeading = heading.checked;
      settings.cutScope = scope.value;
      void this.plugin.saveData(settings);
    };
    options.createEl('button', { cls: 'mod-cta', text: '查找' }).onclick = async () => {
      remember();
      if (!settings.cutStart || !settings.cutEnd) {
        new Notice('开始和结束都要填');
        return;
      }
      result.empty();
      result.createEl('p', { cls: 'eai-hint', text: '正在查找…' });
      const found = await this.plugin.organizer.previewCuts(settings.cutScope, settings.cutStart, settings.cutEnd, settings.cutHeading);
      this.renderCutResult(result, found, settings.cutStart, settings.cutEnd, settings.cutHeading);
    };
  }

  private renderCutResult(box: HTMLElement, found: { path: string; cuts: Cut[] }[], start: string, end: string, headingOnly: boolean) {
    box.empty();
    if (!found.length) {
      box.createEl('p', { cls: 'eai-hint', text: '没有找到同时有开始行和结束行的笔记。可以试试少填几个字，或者取消「开始行必须是标题」。' });
      return;
    }
    const chosen = new Set(found.map((item) => item.path));
    const head = box.createDiv({ cls: 'eai-head' });
    head.createEl('h5', { text: `找到 ${found.length} 篇，共 ${found.reduce((sum, item) => sum + item.cuts.length, 0)} 段` });
    const run = head.createEl('button', { cls: 'mod-warning' });
    const update = () => {
      run.setText(`删除选中的（${chosen.size} 篇）`);
      run.disabled = !chosen.size;
    };
    for (const item of found) {
      const card = box.createDiv({ cls: 'eai-card' });
      const top = card.createEl('label', { cls: 'eai-current' });
      const check = top.createEl('input', { type: 'checkbox' });
      check.checked = true;
      check.onchange = () => {
        if (check.checked) chosen.add(item.path);
        else chosen.delete(item.path);
        update();
      };
      const link = top.createEl('a', { cls: 'eai-link', text: item.path.replace(/\.md$/i, ''), href: '#' });
      link.onclick = (event) => {
        event.preventDefault();
        void this.plugin.openNote(item.path, '', item.cuts[0].from, true);
      };
      for (const cut of item.cuts) {
        const block = card.createDiv({ cls: 'eai-cut-block' });
        block.createDiv({ cls: 'eai-meta', text: `第 ${cut.from + 1}–${cut.to + 1} 行，共 ${cut.lines} 行` });
        block.createDiv({ cls: 'eai-cut-line', text: cut.first });
        if (cut.lines > 2) block.createDiv({ cls: 'eai-meta', text: `……中间 ${cut.lines - 2} 行……` });
        if (cut.lines > 1) block.createDiv({ cls: 'eai-cut-line', text: cut.last });
      }
    }
    run.onclick = async () => {
      if (!(await confirmDialog(this.app, '批量删除段落', `从 ${chosen.size} 篇笔记里删除上面列出的段落？删除后会生成一篇整理记录。建议先确认笔记有备份或同步。`, '删除'))) return;
      let notes = 0;
      let lines = 0;
      for (const path of chosen) {
        try {
          const removed = await this.plugin.organizer.cut(path, start, end, headingOnly);
          if (removed) {
            notes++;
            lines += removed;
          }
        } catch (error) {
          new Notice(`「${path}」删除失败：${message(error)}`, 8000);
        }
      }
      new Notice(`已从 ${notes} 篇笔记里删除 ${lines} 行`);
      const record = await this.plugin.organizer.writeRecord();
      if (record) await this.plugin.openNote(record.path, '', -1, true);
      box.empty();
      await this.refresh();
    };
    update();
  }

  async refresh() {
    this.healthEl.empty();
    this.healthEl.createEl('p', { cls: 'eai-hint', text: '正在体检…' });
    try {
      this.health = await this.plugin.organizer.health();
      this.renderHealth();
    } catch (error) {
      this.healthEl.empty();
      this.healthEl.createEl('p', { cls: 'eai-error', text: message(error) });
    }
    await this.renderPlan();
    await this.renderList();
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
    const health = this.health!;
    const box = this.healthEl;
    box.empty();
    box.createEl('h5', { text: `笔记体检：共 ${health.total} 篇` });
    const grid = box.createDiv({ cls: 'eai-grid eai-health' });
    const card = (key: string, label: string, desc: string, paths: string[], canRun: boolean) => {
      const item = grid.createDiv({ cls: `eai-card${paths.length ? '' : ' is-done'}` });
      item.createDiv({ cls: 'eai-health-count', text: String(paths.length) });
      item.createDiv({ cls: 'eai-link', text: label });
      item.createDiv({ cls: 'eai-meta', text: desc });
      if (!paths.length) return;
      const actions = item.createDiv({ cls: 'eai-actions' });
      actions.createEl('button', { text: this.expanded === key ? '收起' : '查看' }).onclick = () => {
        this.expanded = this.expanded === key ? null : key;
        this.renderHealth();
      };
      if (canRun) actions.createEl('button', { cls: 'mod-cta', text: '整理这些' }).onclick = () => this.run(paths, label, ALL);
    };
    card('recent', '最近 7 天的新笔记', '还没有标签和摘要', health.recent, true);
    card('untagged', '没有标签', '找的时候容易漏掉', health.untagged, true);
    card('orphans', '孤立笔记', '和你的其他笔记没有任何双链往来', health.orphans, true);
    card('poor', '标题看不出内容', '未命名、纯日期等', health.poor, true);
    card('empty', '空笔记', '没有文字、图片、视频等任何内容', health.empty, false);
    const dup = grid.createDiv({ cls: `eai-card${health.duplicates.length ? '' : ' is-done'}` });
    dup.createDiv({ cls: 'eai-health-count', text: String(health.duplicates.length) });
    dup.createDiv({ cls: 'eai-link', text: '重复笔记' });
    dup.createDiv({ cls: 'eai-meta', text: '内容几乎一样的几组' });
    const folders = grid.createDiv({ cls: `eai-card${health.emptyFolders.length ? '' : ' is-done'}` });
    folders.createDiv({ cls: 'eai-health-count', text: String(health.emptyFolders.length) });
    folders.createDiv({ cls: 'eai-link', text: '空文件夹' });
    folders.createDiv({ cls: 'eai-meta', text: '里面没有任何文件' });
    if (health.emptyFolders.length) {
      const actions = folders.createDiv({ cls: 'eai-actions' });
      actions.createEl('button', { text: this.expanded === 'folders' ? '收起' : '查看' }).onclick = () => {
        this.expanded = this.expanded === 'folders' ? null : 'folders';
        this.renderHealth();
      };
      actions.createEl('button', { cls: 'mod-warning', text: '全部删除' }).onclick = async () => {
        if (!(await confirmDialog(this.app, '删除空文件夹', `删除这 ${health.emptyFolders.length} 个空文件夹？${health.emptyFolders.slice(0, 8).join('、')}${health.emptyFolders.length > 8 ? ' 等' : ''}`, '删除'))) return;
        await this.act(() => this.plugin.organizer.removeFolders(health.emptyFolders), '已删除空文件夹');
      };
    }
    if (health.duplicates.length) {
      dup.createDiv({ cls: 'eai-actions' }).createEl('button', { text: this.expanded === 'dup' ? '收起' : '查看' }).onclick = () => {
        this.expanded = this.expanded === 'dup' ? null : 'dup';
        this.renderHealth();
      };
    }
    const lists: Record<string, string[]> = { recent: health.recent, untagged: health.untagged, orphans: health.orphans, poor: health.poor, empty: health.empty };
    if (this.expanded === 'folders') {
      const list = box.createDiv({ cls: 'eai-sources' });
      for (const path of health.emptyFolders) list.createDiv({ text: `📁 ${path}` });
    } else if (this.expanded && this.expanded !== 'dup') {
      const list = box.createDiv({ cls: 'eai-sources' });
      const paths = lists[this.expanded] ?? [];
      paths.slice(0, SHOW).forEach((path) => this.link(list, path));
      if (paths.length > SHOW) list.createDiv({ cls: 'eai-meta', text: `……还有 ${paths.length - SHOW} 篇` });
    }
    if (this.expanded === 'dup') {
      const list = box.createDiv();
      list.createEl('p', { cls: 'eai-hint', text: '选一篇保留。删除和合并都会把其他几篇移到回收站，指向它们的双链会自动改成指向保留的这篇。合并会把其他几篇的正文和标签追加到保留的这篇末尾，正文完全一样的不重复追加。' });
      health.duplicates.slice(0, SHOW).forEach((group, i) => this.renderDuplicate(list, group, i));
    }
    const row = box.createDiv({ cls: 'eai-actions eai-folder-run' });
    row.createSpan({ text: '按范围整理：' });
    const select = row.createEl('select', { cls: 'dropdown' });
    const scopes = this.scopes();
    for (const [value, text] of scopes) select.createEl('option', { text, value });
    if (scopes.some(([value]) => value === this.plugin.settings.organizeFolder)) select.value = this.plugin.settings.organizeFolder;
    const remember = () => {
      this.plugin.settings.organizeFolder = select.value;
      void this.plugin.saveData(this.plugin.settings);
    };
    select.onchange = () => {
      remember();
      void this.renderPlan();
    };
    row.createEl('button', { text: '整理这个范围' }).onclick = () => {
      remember();
      void this.run(this.plugin.organizer.notesIn(select.value), this.scopeLabel(select.value), select.value);
    };
  }

  private async renderPlan() {
    const box = this.planEl;
    box.empty();
    const plan = await this.plugin.organizer.plan();
    const head = box.createDiv({ cls: 'eai-head' });
    const current = this.currentScope();
    const planScope = await this.plugin.organizer.planScope();
    head.createEl('h5', { text: `分类方案（范围：${this.scopeLabel(plan ? planScope : current)}）` });
    if (!plan) {
      box.createEl('p', { cls: 'eai-hint', text: current === ALL || current === ROOT
        ? '想调整文件夹结构（改名、合并、新建分类）时，先让 AI 设计一套方案。确认方案后再生成整理建议，每篇笔记会按新的分类来分配。不需要调整的话可以跳过这一步。想只整理某个文件夹，先在上面「按范围整理」里选中它。'
        : `AI 会只在「${current}」里面设计子分类，比如按主题分成几个子文件夹。确认后点上面的「整理这个范围」，「${current}」里的每篇笔记会按这些子分类来分配。` });
      head.createEl('button', { cls: 'mod-cta', text: '让 AI 设计分类方案' }).onclick = () => this.designPlan();
      return;
    }
    if (planScope !== current) box.createEl('p', { cls: 'eai-warn', text: `当前方案是按「${this.scopeLabel(planScope)}」设计的，上面选的是「${this.scopeLabel(current)}」。要按新范围设计，点「重新设计」。` });
    const tools = head.createDiv({ cls: 'eai-actions' });
    tools.createEl('button', { text: '重新设计' }).onclick = () => this.designPlan();
    tools.createEl('button', { text: '放弃方案' }).onclick = async () => {
      await this.plugin.organizer.setPlan(null);
      await this.renderPlan();
      await this.renderMap();
    };
    if (plan.some((folder) => folder.from.some((from) => from !== folder.path))) tools.createEl('button', { text: '只执行文件夹改名和合并' }).onclick = () => this.runPlan();
    tools.createEl('button', { cls: 'mod-cta', text: '按内容把笔记分进这些分类' }).onclick = () => this.classify();
    box.createEl('p', { cls: 'eai-hint', text: '可以直接改分类名，或删掉不要的。点「按内容把笔记分进这些分类」，AI 会逐篇阅读笔记，按正文主要讲什么给每篇选一个最合适的分类；结果先出现在下面的笔记地图里，确认后点「按地图全部执行」。没有分到笔记的分类不会建文件夹。' });
    const locked = this.plugin.organizer.locked();
    if (locked.length) box.createEl('p', { cls: 'eai-hint', text: `受保护的文件夹（其他插件或附件、模板设置在用，不会改名或移走）：${locked.join('、')}` });
    const existing = new Set(this.plugin.organizer.folders());
    const save = debounce(async () => {
      await this.plugin.organizer.setPlan(plan);
      await this.renderMap();
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
      if (folder.from.some((from) => from !== folder.path && this.plugin.organizer.isLocked(from, locked))) row.createSpan({ cls: 'eai-badge', text: '含受保护文件夹，执行时会跳过' });
      row.createSpan({ cls: 'eai-meta eai-plan-desc', text: folder.desc });
      row.createEl('button', { text: '×' }).onclick = async () => {
        plan.splice(i, 1);
        await this.plugin.organizer.setPlan(plan);
        await this.renderPlan();
        await this.renderMap();
      };
    });
    box.createEl('button', { text: '加一个文件夹' }).onclick = async () => {
      plan.push({ path: '新分类', from: [], desc: '' });
      await this.plugin.organizer.setPlan(plan);
      await this.renderPlan();
    };
  }

  private async designPlan() {
    const scope = this.currentScope();
    const text = scope === ALL || scope === ROOT ? 'AI 会参考你现有的文件夹、每个文件夹里的笔记标题和主题地图，设计一套文件夹结构。' : `AI 会参考「${scope}」里的子文件夹和笔记标题，只在「${scope}」里面设计子分类。`;
    if (!(await confirmDialog(this.app, '设计分类方案', `${text}只调用一次模型，不会改动任何文件。`, '开始设计'))) return;
    const notice = new Notice('正在设计分类方案…', 0);
    try {
      await this.plugin.organizer.generatePlan(scope);
    } catch (error) {
      new Notice(`设计失败：${message(error)}`, 8000);
    }
    notice.hide();
    await this.renderPlan();
    await this.renderMap();
  }

  private async classify() {
    if (this.plugin.organizer.running) {
      new Notice('正在处理，请稍等');
      return;
    }
    const scope = await this.plugin.organizer.planScope();
    const count = Math.min(this.plugin.organizer.notesIn(scope).length, RUN_LIMIT);
    if (!count) {
      new Notice('这个范围里没有可以分类的笔记');
      return;
    }
    if (!(await confirmDialog(this.app, '按内容分类', `AI 会逐篇阅读「${this.scopeLabel(scope)}」里的 ${count} 篇笔记（标题、摘要和正文开头），给每篇选一个最合适的分类，大约调用模型 ${Math.ceil(count / 10)} 次。结果先放进笔记地图让你确认，不会马上移动。`, '开始分类'))) return;
    try {
      const result = await this.plugin.organizer.classify((done, total) => {
        this.statusEl.setText(done < total ? `正在按内容分类：${done}/${total}…` : '');
      });
      new Notice(`分好了：${result.total} 篇里有 ${result.moved} 篇要换分类，请在笔记地图里确认`);
    } catch (error) {
      new Notice(`分类失败：${message(error)}`, 8000);
    }
    this.statusEl.setText('');
    await this.renderList();
    this.mapEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  private async runPlan() {
    const plan = (await this.plugin.organizer.plan()) ?? [];
    const existing = new Set(this.plugin.organizer.folders());
    const created = plan.filter((folder) => !existing.has(folder.path)).length;
    const moved = plan.reduce((sum, folder) => sum + folder.from.filter((from) => from !== folder.path).length, 0);
    if (!(await confirmDialog(this.app, '执行分类方案', `将新建 ${created} 个文件夹，把 ${moved} 个文件夹的内容移到新位置，其他笔记里的链接会自动更新。执行后会生成一篇整理记录。`, '执行'))) return;
    await this.execute(false);
  }

  private async execute(withSuggestions: boolean) {
    const notice = new Notice('正在整理…', 0);
    let changes = 0;
    try {
      changes += await this.plugin.organizer.applyPlan();
      if (withSuggestions) {
        for (const item of [...(await this.plugin.organizer.suggestions())]) {
          if (!Object.values(item.use).some(Boolean)) continue;
          try {
            await this.plugin.organizer.apply(item);
            changes++;
          } catch (error) {
            new Notice(`「${item.path}」整理失败：${message(error)}`, 8000);
          }
        }
      }
    } catch (error) {
      new Notice(`整理失败：${message(error)}`, 8000);
    }
    notice.hide();
    const record = await this.plugin.organizer.writeRecord();
    new Notice(changes ? `整理完成，改动 ${changes} 处` : '没有需要改动的');
    if (record) await this.plugin.openNote(record.path, '', -1, true);
    await this.refresh();
  }

  private async renderMap() {
    const box = this.mapEl;
    box.empty();
    const map = await this.plugin.organizer.map();
    const head = box.createDiv({ cls: 'eai-head' });
    head.createEl('h5', { text: `笔记地图（整理后的样子）：${map.changed} 处变化` });
    const tools = head.createDiv({ cls: 'eai-actions' });
    const toggle = tools.createEl('label', { cls: 'eai-current' });
    const box2 = toggle.createEl('input', { type: 'checkbox' });
    box2.checked = this.onlyChanged;
    box2.onchange = () => {
      this.onlyChanged = box2.checked;
      void this.renderMap();
    };
    toggle.createSpan({ text: '只看有变化的' });
    const logged = await this.plugin.organizer.logSize();
    if (logged) {
      tools.createEl('button', { text: `生成整理记录（${logged} 处）` }).onclick = async () => {
        const record = await this.plugin.organizer.writeRecord();
        if (record) await this.plugin.openNote(record.path, '', -1, true);
        await this.renderMap();
      };
    }
    if (map.changed || (await this.plugin.organizer.plan())) {
      tools.createEl('button', { cls: 'mod-cta', text: '按地图全部执行' }).onclick = async () => {
        if (!(await confirmDialog(this.app, '按地图全部执行', `执行分类方案，并应用所有勾选的整理建议（共 ${map.changed} 篇笔记有位置或标题变化）。其他笔记里的链接会自动更新，完成后生成一篇整理记录。`, '全部执行'))) return;
        await this.execute(true);
      };
    }
    box.createEl('p', { cls: 'eai-hint', text: '按「分类方案」和勾选的「整理建议」推算出来，还没有真正移动。🆕 是新建的文件夹，蓝色是从别处移来或改了名的笔记。' });
    const tree = box.createDiv({ cls: 'eai-tree-root' });
    this.renderTree(tree, map, 0);
    if (!tree.childElementCount) tree.createEl('p', { cls: 'eai-hint', text: '还没有变化。' });
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
        if (!(await confirmDialog(this.app, '删除重复笔记', `保留《${name}》，把 ${others} 移到回收站？`, '删除其他'))) return;
        await this.act(() => this.plugin.organizer.keepOnly(path, group), '已删除重复笔记');
      };
      actions.createEl('button', { text: '合并到这篇' }).onclick = async () => {
        if (!(await confirmDialog(this.app, '合并重复笔记', `把 ${others} 的正文和标签追加到《${name}》末尾，然后把它们移到回收站？`, '合并'))) return;
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
      new Notice('正在生成整理建议，请稍等');
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
    const ok = await confirmDialog(
      this.app,
      '生成整理建议',
      `用 AI 为「${label}」的 ${count} 篇笔记生成整理建议${more}，大约调用模型 ${Math.ceil(count / 5)} 次。生成后你可以逐条修改和确认，确认之前不会改动任何笔记。`,
      '开始生成'
    );
    if (!ok) return;
    try {
      const made = await this.plugin.organizer.generate(usable, (done, total) => {
        this.statusEl.setText(done < total ? `正在生成整理建议：${done}/${total}…` : '');
      }, scope);
      new Notice(`生成了 ${made} 条整理建议，请在下面确认`);
    } catch (error) {
      new Notice(`生成失败：${message(error)}`, 8000);
    }
    this.statusEl.setText('');
    await this.renderList();
    this.plugin.refreshStatus();
  }

  private async renderList() {
    const box = this.listEl;
    box.empty();
    const list = await this.plugin.organizer.suggestions();
    const head = box.createDiv({ cls: 'eai-head' });
    head.createEl('h5', { text: `整理建议（${list.length}）` });
    void this.renderMap();
    if (!list.length) {
      box.createEl('p', { cls: 'eai-hint', text: '还没有待确认的建议。在上面选一类笔记，点「整理这些」，或者按范围整理。' });
      return;
    }
    const tools = head.createDiv({ cls: 'eai-actions' });
    tools.createEl('button', { cls: 'mod-cta', text: '应用全部勾选的' }).onclick = () => this.applyAll(list);
    tools.createEl('button', { text: '全部跳过' }).onclick = async () => {
      if (!(await confirmDialog(this.app, '全部跳过', `跳过这 ${list.length} 条建议？跳过的笔记不会再出现在「最近 7 天的新笔记」里。`, '全部跳过'))) return;
      for (const item of [...list]) await this.plugin.organizer.skip(item);
      await this.renderList();
    };
    const folders = this.plugin.organizer.targetFolders();
    for (const item of list) this.renderCard(box, item, folders);
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

  private renderCard(parent: HTMLElement, item: Suggestion, folders: string[]) {
    const card = parent.createDiv({ cls: 'eai-card eai-suggest' });
    const title = card.createEl('a', { cls: 'eai-link', text: item.path.split('/').pop()!.replace(/\.md$/i, ''), href: '#' });
    title.onclick = (event) => {
      event.preventDefault();
      void this.plugin.openNote(item.path, '', -1, true);
    };
    card.createDiv({ cls: 'eai-meta', text: item.path });
    const text = (body: HTMLElement, value: string, placeholder: string, set: (value: string) => void) => {
      const input = body.createEl('input', { type: 'text', value, attr: { placeholder } });
      input.oninput = () => {
        set(input.value);
        this.persist();
      };
    };
    text(this.field(card, '摘要', item.use.summary, (v) => (item.use.summary = v)), item.summary, '一句话摘要', (v) => (item.summary = v));
    text(this.field(card, '加标签', item.use.tags, (v) => (item.use.tags = v)), item.tags.join(' '), '用空格分开', (v) => (item.tags = v.split(/[\s,，、]+/).filter(Boolean)));
    const move = this.field(card, '移到', item.use.folder, (v) => (item.use.folder = v));
    const select = move.createEl('select', { cls: 'dropdown' });
    select.createEl('option', { text: '（根目录）', value: '' });
    for (const folder of folders) select.createEl('option', { text: folder, value: folder });
    select.value = item.folder;
    select.onchange = () => {
      item.folder = select.value;
      this.persist();
    };
    if (item.folder === folderOf(item.path)) move.createSpan({ cls: 'eai-meta', text: ' 现在的位置' });
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
        await this.plugin.organizer.apply(item);
        new Notice('已整理');
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
      if (!(await confirmDialog(this.app, '删除笔记', `把《${name}》移到回收站？之后可以在回收站里找回。`, '删除'))) return;
      await this.act(() => this.plugin.organizer.trash(item.path), '已移到回收站');
    };
  }

  private async applyAll(list: Suggestion[]) {
    const chosen = list.filter((item) => Object.values(item.use).some(Boolean));
    if (!chosen.length) {
      new Notice('没有勾选任何修改');
      return;
    }
    if (!(await confirmDialog(this.app, '应用整理建议', `把勾选的修改写入这 ${chosen.length} 篇笔记？移动和改名会自动更新其他笔记里指向它们的链接。`, '应用'))) return;
    let ok = 0;
    for (const item of chosen) {
      try {
        await this.plugin.organizer.apply(item);
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
