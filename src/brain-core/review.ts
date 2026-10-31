import { seeded, shuffle } from './random';

export const DAY = 86_400_000;
export const INTERVALS = [1, 3, 7, 15, 30, 60, 120];
const FRESH_AGE = 14 * DAY;

export interface ReviewItem {
  step: number;
  due: number;
  last: number;
}

export interface DailyPick {
  path: string;
  reason: string;
}

export interface ReviewState {
  items: Record<string, ReviewItem>;
  skipped: string[];
  date: string;
  picks: DailyPick[];
  done: string[];
  lastWeekly: string;
}

export function freshReview(): ReviewState {
  return { items: {}, skipped: [], date: '', picks: [], done: [], lastWeekly: '' };
}

function pad(value: number) {
  return String(value).padStart(2, '0');
}

export function dayKey(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function startOfDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function weekKey(time: number): string {
  const date = new Date(startOfDay(time));
  const weekday = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - weekday + 3);
  const first = new Date(date.getFullYear(), 0, 4);
  const week = 1 + Math.round(((date.getTime() - first.getTime()) / DAY - 3 + ((first.getDay() + 6) % 7)) / 7);
  return `${date.getFullYear()}-W${pad(week)}`;
}

export function markReview(state: ReviewState, path: string, remembered: boolean, now: number) {
  const item = state.items[path] ?? { step: -1, due: 0, last: 0 };
  const step = remembered ? Math.min(item.step + 1, INTERVALS.length - 1) : 0;
  state.items[path] = { step, due: startOfDay(now) + INTERVALS[step] * DAY, last: now };
  if (!state.done.includes(path)) state.done.push(path);
}

export function skipReview(state: ReviewState, path: string) {
  delete state.items[path];
  if (!state.skipped.includes(path)) state.skipped.push(path);
  if (!state.done.includes(path)) state.done.push(path);
}

export interface Candidate {
  path: string;
  created: number;
}

export function pickDaily(
  state: ReviewState,
  candidates: Candidate[],
  related: DailyPick[],
  now: number,
  count = 5
): DailyPick[] {
  const alive = new Set(candidates.map((item) => item.path));
  const skipped = new Set(state.skipped);
  const end = startOfDay(now) + DAY;
  const picks: DailyPick[] = Object.entries(state.items)
    .filter(([path, item]) => item.due < end && alive.has(path) && !skipped.has(path))
    .sort((a, b) => a[1].due - b[1].due)
    .slice(0, count)
    .map(([path, item]) => ({ path, reason: `第 ${item.step + 2} 次回顾` }));
  const used = new Set(picks.map((item) => item.path));
  const usable = (path: string) => !used.has(path) && !skipped.has(path) && !state.items[path];
  const old = new Set(candidates.filter((item) => now - item.created > FRESH_AGE).map((item) => item.path));
  for (const item of related) {
    if (picks.length >= count) break;
    if (!old.has(item.path) || !usable(item.path)) continue;
    picks.push(item);
    used.add(item.path);
  }
  for (const path of shuffle([...old], seeded(dayKey(now)))) {
    if (picks.length >= count) break;
    if (!usable(path)) continue;
    picks.push({ path, reason: '好久没看的旧笔记' });
    used.add(path);
  }
  return picks;
}
