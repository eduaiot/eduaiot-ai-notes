import { App, Modal } from 'obsidian';

class ConfirmModal extends Modal {
  private answered = false;
  private observer: ResizeObserver | null = null;

  constructor(
    app: App,
    private readonly heading: string,
    private readonly text: string,
    private readonly action: string,
    private readonly done: (ok: boolean) => void,
    private readonly anchor?: HTMLElement
  ) {
    super(app);
  }

  onOpen() {
    this.modalEl.addClass('eai-confirm');
    this.titleEl.setText(this.heading);
    this.contentEl.createEl('p', { cls: 'eai-confirm-text', text: this.text });
    const actions = this.contentEl.createDiv({ cls: 'eai-actions eai-confirm-actions' });
    actions.createEl('button', { text: '取消' }).onclick = () => this.finish(false);
    actions.createEl('button', { cls: 'mod-cta', text: this.action }).onclick = () => this.finish(true);
    if (this.anchor) {
      this.containerEl.addClass('eai-confirm-host');
      this.place();
      requestAnimationFrame(() => this.place());
      this.observer = new ResizeObserver(() => this.place());
      this.observer.observe(this.anchor);
      window.addEventListener('resize', this.place);
    }
  }

  private readonly place = () => {
    if (!this.anchor) return;
    const rect = this.anchor.getBoundingClientRect();
    this.containerEl.setCssProps({
      top: `${Math.max(0, rect.top)}px`,
      left: `${Math.max(0, rect.left)}px`,
      width: `${Math.max(0, rect.width)}px`,
      height: `${Math.max(0, rect.height)}px`
    });
  };

  private finish(ok: boolean) {
    if (this.answered) return;
    this.answered = true;
    this.done(ok);
    this.close();
  }

  onClose() {
    this.observer?.disconnect();
    this.observer = null;
    window.removeEventListener('resize', this.place);
    this.finish(false);
    this.contentEl.empty();
  }
}

export function confirmDialog(app: App, heading: string, text: string, action = '开始', anchor?: HTMLElement): Promise<boolean> {
  return new Promise((resolve) => new ConfirmModal(app, heading, text, action, resolve, anchor).open());
}
