import { App, Modal, Notice } from 'obsidian';
import { INTERVIEW } from './core';
import type AiNotesPlugin from './main';

export class InterviewModal extends Modal {
  private saved = false;

  constructor(app: App, private readonly plugin: AiNotesPlugin) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    this.titleEl.setText('先认识一下你');
    contentEl.addClass('eai-interview');
    contentEl.createEl('p', { cls: 'eai-hint', text: '回答几个问题，AI 会更懂你在做什么，问答、选题、灵感卡都会更贴合你。你写的内容会直接记进「我的画像」，算作已确认；不想答的留空就行，以后也可以在画像里改。' });
    const inputs = new Map<string, HTMLTextAreaElement>();
    for (const item of INTERVIEW) {
      const field = contentEl.createDiv({ cls: 'eai-interview-field' });
      field.createDiv({ cls: 'eai-link', text: item.question });
      const input = field.createEl('textarea', { cls: 'eai-textarea', attr: { placeholder: `${item.placeholder}（每行一条）`, rows: '2' } });
      inputs.set(item.section, input);
    }
    const actions = contentEl.createDiv({ cls: 'eai-actions' });
    actions.createEl('button', { cls: 'mod-cta', text: '保存' }).onclick = async () => {
      const answers: Record<string, string> = {};
      for (const [section, input] of inputs) answers[section] = input.value;
      const count = await this.plugin.profile.saveInterview(answers);
      this.saved = true;
      this.close();
      const status = await this.plugin.profile.status();
      new Notice(`已记进画像 ${count} 条。${status.waiting ? `按意思搜索准备好（现在 ${Math.floor(status.coverage * 100)}%）后，AI 会再从各个主题的笔记里补充画像。` : ''}`, 8000);
      this.plugin.refreshToday();
    };
    actions.createEl('button', { text: '跳过' }).onclick = () => this.close();
  }

  onClose() {
    if (!this.saved) void this.plugin.profile.skipInterview().then(() => this.plugin.refreshToday());
    this.contentEl.empty();
  }
}
