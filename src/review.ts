import { Notice } from 'obsidian';
import { DAY, dayKey, freshReview, markReview, pickDaily, skipReview, weekKey, type DailyPick, type ReviewState } from './core';
import type AiNotesPlugin from './main';
import { readState, writeState } from './store';

const RECENT_DAYS = 7;
const DAILY = 5;
const MIN_WEEKLY_NOTES = 3;

export interface Card extends DailyPick {
  title: string;
  preview: string;
  done: boolean;
}

export class Reviewer {
  private state: ReviewState = freshReview();
  private loaded: Promise<void> | null = null;
  private weeklyRunning = false;

  constructor(private readonly plugin: AiNotesPlugin) {}

  private load() {
    if (!this.loaded) {
      this.loaded = readState(this.plugin.app, 'review', freshReview()).then((state) => {
        this.state = state;
      });
    }
    return this.loaded;
  }

  private save() {
    return writeState(this.plugin.app, 'review', this.state);
  }

  private related(): DailyPick[] {
    const engine = this.plugin.local.engine;
    const since = Date.now() - RECENT_DAYS * DAY;
    const recent = engine.list().filter((note) => note.mtime >= since).sort((a, b) => b.mtime - a.mtime).slice(0, 5);
    const out: DailyPick[] = [];
    for (const note of recent) {
      for (const hit of engine.related(note.path, 5)) out.push({ path: hit.path, reason: `和你最近在看的《${note.title}》相关` });
    }
    return out;
  }

  async cards(): Promise<Card[]> {
    await this.load();
    await this.plugin.local.start();
    const engine = this.plugin.local.engine;
    const now = Date.now();
    const key = dayKey(now);
    if (this.state.date !== key) {
      const candidates = engine.list().map((note) => ({ path: note.path, created: note.created }));
      this.state.picks = pickDaily(this.state, candidates, this.related(), now, DAILY);
      this.state.date = key;
      this.state.done = [];
      await this.save();
    }
    return this.state.picks
      .filter((pick) => engine.has(pick.path))
      .map((pick) => ({ ...pick, title: engine.title(pick.path), preview: engine.preview(pick.path), done: this.state.done.includes(pick.path) }));
  }

  pendingCount(): number {
    if (this.state.date !== dayKey(Date.now())) return 0;
    return this.state.picks.filter((pick) => !this.state.done.includes(pick.path)).length;
  }

  async mark(path: string, remembered: boolean) {
    await this.load();
    markReview(this.state, path, remembered, Date.now());
    await this.save();
  }

  async skip(path: string) {
    await this.load();
    skipReview(this.state, path);
    await this.save();
  }

  async weekly(force = false) {
    const settings = this.plugin.settings;
    if (this.weeklyRunning) return;
    await this.load();
    const now = new Date();
    const week = weekKey(now.getTime());
    const weekday = (now.getDay() + 6) % 7 + 1;
    if (!force && (!settings.weekly || this.state.lastWeekly === week || weekday < settings.weeklyDay || !this.plugin.local.chatReady())) return;
    this.weeklyRunning = true;
    try {
      await this.plugin.local.start();
      const since = Date.now() - 7 * DAY;
      const count = this.plugin.local.engine.list().filter((note) => note.mtime >= since).length;
      if (count < MIN_WEEKLY_NOTES && !force) {
        this.state.lastWeekly = week;
        await this.save();
        return;
      }
      const file = await this.plugin.skills.runByName('每周回顾');
      if (file) {
        this.state.lastWeekly = week;
        await this.save();
        if (!force) new Notice('本周周报已自动生成');
      }
    } finally {
      this.weeklyRunning = false;
    }
  }
}
