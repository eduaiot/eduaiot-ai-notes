import { ItemView, TFile, WorkspaceLeaf } from 'obsidian';
import { message } from './backend';
import { InterviewModal } from './interview';
import type AiNotesPlugin from './main';

export const TODAY_VIEW = 'eduaiot-ai-notes-today';

export class TodayView extends ItemView {
  private seq = 0;

  constructor(leaf: WorkspaceLeaf, private readonly plugin: AiNotesPlugin) {
    super(leaf);
  }

  getViewType() {
    return TODAY_VIEW;
  }

  getDisplayText() {
    return '今日笔记';
  }

  getIcon() {
    return 'calendar-check';
  }

  async onOpen() {
    this.contentEl.addClass('eai-panel');
    await this.refresh();
  }

  async refresh() {
    const seq = ++this.seq;
    const root = this.contentEl;
    root.empty();
    const head = root.createDiv({ cls: 'eai-head' });
    head.createEl('h5', { text: '今日回顾' });
    head.createEl('button', { text: '刷新' }).onclick = () => this.refresh();
    root.createEl('p', { cls: 'eai-hint', text: '每天挑几篇旧笔记给你重温。点「记得」会隔得越来越久再出现，点「忘了」明天再看。' });
    const list = root.createDiv();
    list.createEl('p', { cls: 'eai-hint', text: '正在挑选…' });
    const profile = root.createDiv();
    this.actions(root);
    void this.renderProfile(profile, seq);
    try {
      const cards = await this.plugin.reviewer.cards();
      if (seq !== this.seq) return;
      list.empty();
      if (!cards.length) list.createEl('p', { cls: 'eai-hint', text: '今天没有要回顾的笔记。记满两周的笔记会开始出现在这里。' });
      for (const card of cards) {
        const box = list.createDiv({ cls: `eai-card${card.done ? ' is-done' : ''}` });
        const link = box.createEl('a', { cls: 'eai-link', text: card.title, href: '#' });
        link.onclick = (event) => {
          event.preventDefault();
          void this.plugin.openNote(card.path);
        };
        box.createDiv({ cls: 'eai-meta', text: card.reason });
        if (card.preview) box.createDiv({ cls: 'eai-snippet', text: card.preview });
        if (card.done) {
          box.createDiv({ cls: 'eai-meta', text: '今天已回顾' });
          continue;
        }
        const actions = box.createDiv({ cls: 'eai-actions' });
        const act = (text: string, run: () => Promise<void>) => {
          actions.createEl('button', { text }).onclick = async () => {
            await run();
            this.plugin.refreshStatus();
            await this.refresh();
          };
        };
        act('记得', () => this.plugin.reviewer.mark(card.path, true));
        act('忘了', () => this.plugin.reviewer.mark(card.path, false));
        act('不再提醒', () => this.plugin.reviewer.skip(card.path));
        actions.createEl('button', { text: '灵感卡' }).onclick = async () => {
          await this.plugin.openNote(card.path);
          const file = this.app.vault.getAbstractFileByPath(card.path);
          await this.plugin.skills.runByName('灵感卡', { file: file instanceof TFile ? file : null });
        };
      }
      this.plugin.refreshStatus();
    } catch (error) {
      if (seq !== this.seq) return;
      list.empty();
      list.createEl('p', { cls: 'eai-error', text: message(error) });
    }
  }

  private async renderProfile(root: HTMLElement, seq: number) {
    const pending = await this.plugin.profile.pending();
    const status = await this.plugin.profile.status();
    if (seq !== this.seq) return;
    root.empty();
    const head = root.createDiv({ cls: 'eai-head' });
    head.createEl('h5', { text: pending.length ? `画像待确认（${pending.length}）` : '我的画像' });
    head.createEl('button', { text: '打开画像' }).onclick = () => this.plugin.profile.open();
    if (!status.interviewed) {
      const card = root.createDiv({ cls: 'eai-card' });
      card.createDiv({ text: '回答几个问题，让 AI 更懂你在做什么。你写的直接算作已确认。' });
      card.createDiv({ cls: 'eai-actions' }).createEl('button', { cls: 'mod-cta', text: '开始回答' }).onclick = () => new InterviewModal(this.app, this.plugin).open();
    }
    if (status.waiting) {
      const card = root.createDiv({ cls: 'eai-card' });
      card.createDiv({ text: `向量计算中（${Math.floor(status.coverage * 100)}%）。算完后会自动从各个主题里挑代表笔记，第一次分析你的画像，覆盖更全。` });
      card.createDiv({ cls: 'eai-actions' }).createEl('button', { text: '不等了，现在按文件夹分析' }).onclick = async () => {
        await this.plugin.profile.update(false);
        await this.refresh();
      };
    } else if (status.first && !pending.length) {
      const card = root.createDiv({ cls: 'eai-card' });
      card.createDiv({ text: '还没有分析过你的画像。' });
      card.createDiv({ cls: 'eai-actions' }).createEl('button', { text: '现在分析' }).onclick = async () => {
        await this.plugin.profile.update(false);
        await this.refresh();
      };
    }
    if (!pending.length) {
      root.createEl('p', { cls: 'eai-hint', text: 'AI 从笔记里发现关于你的新信息时，会先放在这里等你确认。确认过的才会在问答和技能里使用。' });
      return;
    }
    for (const item of pending.slice(0, 5)) {
      const box = root.createDiv({ cls: 'eai-card' });
      box.createDiv({ cls: 'eai-meta', text: item.section });
      box.createDiv({ text: item.text });
      const actions = box.createDiv({ cls: 'eai-actions' });
      actions.createEl('button', { cls: 'mod-cta', text: '对，确认' }).onclick = async () => {
        await this.plugin.profile.confirm(item);
        await this.renderProfile(root, this.seq);
      };
      actions.createEl('button', { text: '不对' }).onclick = async () => {
        await this.plugin.profile.reject(item);
        await this.renderProfile(root, this.seq);
      };
    }
    if (pending.length > 5) root.createEl('p', { cls: 'eai-hint', text: `还有 ${pending.length - 5} 条，可以打开画像直接改` });
  }

  private actions(root: HTMLElement) {
    root.createEl('h5', { text: '把笔记用起来' });
    const grid = root.createDiv({ cls: 'eai-grid' });
    const add = (text: string, desc: string, run: () => unknown) => {
      const button = grid.createEl('button', { cls: 'eai-tile' });
      button.createDiv({ cls: 'eai-link', text });
      button.createDiv({ cls: 'eai-meta', text: desc });
      button.onclick = () => void run();
    };
    add('整理笔记', '体检 + AI 整理建议', () => this.plugin.openOrganize());
    add('本周周报', '回顾这 7 天', () => this.plugin.reviewer.weekly(true));
    add('爆款规律', '拆解收藏的短视频', () => this.plugin.skills.runByName('爆款规律'));
    add('选题生成', '10 个能做的选题', () => this.plugin.skills.runByName('选题生成'));
    add('更新画像', '从笔记里了解你', async () => {
      await this.plugin.profile.update();
      await this.refresh();
    });
    add('多篇合稿', '选几篇合成草稿', () => this.plugin.skills.runByName('多篇合稿', { file: this.plugin.currentFile() }));
    add('主题地图', '关系图谱看全貌', () => this.plugin.topics.show());
    add('跨领域灵感', '不同主题碰一碰', () => this.plugin.topics.inspire());
    add('全部技能', '包括你自己写的', () => this.plugin.openSkills());
    add('技能市场', '安装更多技能包', () => this.plugin.openMarket());
  }
}
