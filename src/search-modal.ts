import { App, Notice, SuggestModal } from 'obsidian';
import { message } from './backend';
import type { Hit } from './core';
import type AiNotesPlugin from './main';

const WAIT_MS = 350;

export class SearchModal extends SuggestModal<Hit> {
  private timer = 0;
  private seq = 0;
  private last: Hit[] = [];
  private resolveLast: ((hits: Hit[]) => void) | null = null;

  constructor(app: App, private readonly plugin: AiNotesPlugin, private readonly initial = '') {
    super(app);
    this.setPlaceholder('写下想找的意思，不用记原话，比如：怎么给孩子讲递归');
    this.emptyStateText = '没有找到相关的笔记';
  }

  onOpen() {
    super.onOpen();
    if (this.initial) {
      this.inputEl.value = this.initial;
      this.inputEl.dispatchEvent(new Event('input'));
    }
  }

  getSuggestions(query: string): Promise<Hit[]> {
    const text = query.trim();
    window.clearTimeout(this.timer);
    this.resolveLast?.(this.last);
    this.resolveLast = null;
    if (!text) return Promise.resolve([]);
    const seq = ++this.seq;
    return new Promise((resolve) => {
      this.resolveLast = resolve;
      this.timer = window.setTimeout(async () => {
        this.resolveLast = null;
        try {
          const hits = await this.plugin.backend.search(text, 20);
          if (seq === this.seq) this.last = hits;
          resolve(this.last);
        } catch (error) {
          new Notice(message(error));
          resolve([]);
        }
      }, WAIT_MS);
    });
  }

  renderSuggestion(hit: Hit, el: HTMLElement) {
    el.addClass('eai-suggestion');
    el.createDiv({ cls: 'eai-link', text: hit.title });
    if (hit.heading) el.createDiv({ cls: 'eai-meta', text: hit.heading });
    if (hit.snippet) el.createDiv({ cls: 'eai-snippet', text: hit.snippet });
  }

  onChooseSuggestion(hit: Hit) {
    void this.plugin.openNote(hit.path, hit.heading, hit.line);
  }
}
