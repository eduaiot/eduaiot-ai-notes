import { App, Modal } from 'obsidian';

class ConfirmModal extends Modal {
  private answered = false;

  constructor(app: App, private readonly heading: string, private readonly text: string, private readonly action: string, private readonly done: (ok: boolean) => void) {
    super(app);
  }

  onOpen() {
    this.titleEl.setText(this.heading);
    this.contentEl.createEl('p', { text: this.text });
    const actions = this.contentEl.createDiv({ cls: 'eai-actions' });
    actions.createEl('button', { cls: 'mod-cta', text: this.action }).onclick = () => this.finish(true);
    actions.createEl('button', { text: '取消' }).onclick = () => this.finish(false);
  }

  private finish(ok: boolean) {
    if (this.answered) return;
    this.answered = true;
    this.done(ok);
    this.close();
  }

  onClose() {
    this.finish(false);
    this.contentEl.empty();
  }
}

export function confirmDialog(app: App, heading: string, text: string, action = '开始'): Promise<boolean> {
  return new Promise((resolve) => new ConfirmModal(app, heading, text, action, resolve).open());
}
