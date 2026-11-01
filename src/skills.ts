import { App, normalizePath, Notice, SuggestModal, TFile } from 'obsidian';
import { message } from './backend';
import { DAY, fill, parseSkill, PRESET_SKILLS, seeded, shuffle, skillMessages, type NoteSummary, type Skill } from './core';
import type AiNotesPlugin from './main';
import { PickModal } from './pick-modal';
import { ensureFolder, outputFolder, skillFolder, writeAiNote } from './store';

export interface RunOptions {
  file?: TFile | null;
  selection?: string;
  paths?: string[];
}

function range(days: number, now = new Date()) {
  const start = new Date(now.getTime() - (days - 1) * DAY);
  const label = (date: Date) => `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${label(start)}—${label(now)}`;
}

export class SkillRunner {
  private running = false;

  constructor(private readonly plugin: AiNotesPlugin) {}

  private get app() {
    return this.plugin.app;
  }

  async installPresets(overwrite = false) {
    await ensureFolder(this.app, skillFolder());
    let count = 0;
    for (const item of PRESET_SKILLS) {
      const path = normalizePath(`${skillFolder()}/${item.file}`);
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing instanceof TFile) {
        if (!overwrite) continue;
        await this.app.vault.modify(existing, item.text);
      } else {
        await this.app.vault.create(path, item.text);
      }
      count++;
    }
    return count;
  }

  async list(): Promise<Skill[]> {
    const read = async () => {
      const skills: Skill[] = [];
      for (const file of this.app.vault.getMarkdownFiles()) {
        if (!file.path.startsWith(`${skillFolder()}/`)) continue;
        const skill = parseSkill(file.path, await this.app.vault.cachedRead(file));
        if (skill) skills.push(skill);
      }
      return skills.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    };
    let skills = await read();
    if (!skills.length) {
      await this.installPresets();
      skills = await read();
    }
    return skills;
  }

  async find(name: string): Promise<Skill | null> {
    const skills = await this.list();
    const found = skills.find((skill) => skill.name === name);
    if (found) return found;
    const preset = PRESET_SKILLS.find((item) => item.file === `${name}.md`);
    return preset ? parseSkill(`${skillFolder()}/${preset.file}`, preset.text) : null;
  }

  async runByName(name: string, options: RunOptions = {}) {
    const skill = await this.find(name);
    if (!skill) {
      new Notice(`找不到技能「${name}」`);
      return null;
    }
    return this.run(skill, options);
  }

  private recent(notes: NoteSummary[], skill: Skill) {
    const since = Date.now() - skill.days * DAY;
    return notes
      .filter((note) => note.mtime >= since && (!skill.has || note.meta[skill.has]))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, skill.limit)
      .map((note) => note.path);
  }

  private sample(notes: NoteSummary[], skill: Skill) {
    const sorted = [...notes].filter((note) => !skill.has || note.meta[skill.has]).sort((a, b) => b.mtime - a.mtime);
    const half = Math.ceil(skill.limit / 2);
    const recent = sorted.slice(0, half).map((note) => note.path);
    const older = shuffle(sorted.slice(half).map((note) => note.path), seeded(`${skill.name}${Date.now()}`)).slice(0, skill.limit - half);
    return [...recent, ...older];
  }

  private async cross(file: TFile, skill: Skill) {
    const engine = this.plugin.local.engine;
    const topics = await this.plugin.topics.assignments();
    const folder = (path: string) => path.split('/')[0];
    const mine = topics.get(file.path);
    const related = engine.related(file.path, 40).map((hit) => hit.path);
    const different = related.filter((path) => (mine !== undefined && topics.has(path) ? topics.get(path) !== mine : folder(path) !== folder(file.path)));
    return [...new Set([...different, ...related])].slice(0, Math.max(skill.limit - 1, 1));
  }

  private async resolve(skill: Skill, options: RunOptions): Promise<string[] | null> {
    const notes = this.plugin.local.engine.list();
    switch (skill.scope) {
      case 'current':
        return [];
      case 'recent':
        return this.recent(notes, skill);
      case 'sample':
        return this.sample(notes, skill);
      case 'search':
        return (await this.plugin.local.search(skill.query || skill.name, skill.limit)).map((hit) => hit.path);
      case 'cross':
        return options.file ? this.cross(options.file, skill) : [];
      case 'pick':
        return new PickModal(this.app, this.plugin, {
          title: `「${skill.name}」选笔记`,
          action: `开始${skill.name}`,
          limit: skill.limit,
          min: 2,
          initial: options.paths?.length ? options.paths : options.file ? [options.file.path] : []
        }).pick();
    }
  }

  async run(skill: Skill, options: RunOptions = {}): Promise<TFile | null> {
    if (this.running) {
      new Notice('有一个技能正在运行，请稍等');
      return null;
    }
    const local = this.plugin.local;
    if (!local.chatReady()) {
      new Notice('还没有设置好对话模型，请在插件设置里填写 API key');
      return null;
    }
    if ((skill.scope === 'current' || skill.scope === 'cross') && !options.file) {
      new Notice(`「${skill.name}」需要先打开一篇笔记`);
      return null;
    }
    this.running = true;
    let notice: Notice | null = null;
    try {
      await local.start();
      const paths = await this.resolve(skill, options);
      if (paths === null) return null;
      const pin = options.file && (skill.scope === 'current' || skill.scope === 'cross')
        ? { path: options.file.path, text: await this.app.vault.cachedRead(options.file) }
        : null;
      const groups = local.engine.groups(paths, pin);
      if (!groups.length) {
        new Notice(skill.scope === 'recent' ? `最近 ${skill.days} 天没有符合条件的笔记` : '没有找到可以用的笔记');
        return null;
      }
      notice = new Notice(`正在运行「${skill.name}」，参考 ${groups.length} 篇笔记…`, 0);
      const task = fill(skill.prompt, { range: range(skill.days), date: new Date().toLocaleDateString('zh-CN'), title: options.file?.basename ?? '' });
      const text = await local.complete(skillMessages(task, groups, options.selection ?? '', {}, await this.plugin.profile.promptText()), 4000);
      const title = pin ? `${skill.name}：${options.file!.basename}` : skill.scope === 'recent' ? `${skill.name} ${range(skill.days)}` : skill.name;
      const file = await writeAiNote(this.app, { folder: outputFolder(skill.output), name: title, title, kind: skill.name, body: text, sources: groups.map((group) => group.source) });
      notice.hide();
      notice = null;
      await this.app.workspace.getLeaf(true).openFile(file);
      new Notice(`「${skill.name}」完成`);
      return file;
    } catch (error) {
      new Notice(`「${skill.name}」失败：${message(error)}`, 8000);
      return null;
    } finally {
      notice?.hide();
      this.running = false;
    }
  }
}

export class SkillModal extends SuggestModal<Skill> {
  constructor(app: App, private readonly plugin: AiNotesPlugin, private readonly skills: Skill[], private readonly options: RunOptions) {
    super(app);
    this.setPlaceholder('选择一个技能');
  }

  getSuggestions(query: string) {
    const text = query.trim();
    return this.skills.filter((skill) => !text || skill.name.includes(text) || skill.description.includes(text));
  }

  renderSuggestion(skill: Skill, el: HTMLElement) {
    el.createDiv({ cls: 'eai-link', text: skill.name });
    if (skill.description) el.createDiv({ cls: 'eai-snippet', text: skill.description });
  }

  onChooseSuggestion(skill: Skill) {
    void this.plugin.skills.run(skill, this.options);
  }
}
