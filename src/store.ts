import { App, normalizePath, TFile } from 'obsidian';
import { verifyAnswer, type Source } from './core';

export const DEFAULT_ROOT = '_易度助手';
export const LEGACY_ROOT = 'AI 笔记';
let root = DEFAULT_ROOT;

export function setRoot(name: string) {
  root = normalizePath(name.trim() || DEFAULT_ROOT);
}

export function aiRoot() {
  return root;
}

export function inRoot(sub: string) {
  return normalizePath(`${root}/${sub}`);
}

export function skillFolder() {
  return inRoot('技能');
}

function stateDir() {
  return `${root}/.state`;
}

export function outputFolder(output: string): string {
  const value = output.trim().replace(/^\/+|\/+$/g, '');
  if (!value) return inRoot('输出');
  if (value === LEGACY_ROOT || value.startsWith(`${LEGACY_ROOT}/`)) return inRoot(value.slice(LEGACY_ROOT.length + 1) || '输出');
  if (value === root || value.startsWith(`${root}/`)) return value;
  return value.includes('/') ? normalizePath(value) : inRoot(value);
}

function pad(value: number) {
  return String(value).padStart(2, '0');
}

export function today(now = new Date()) {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function stamp(now = new Date()) {
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

export function safeName(text: string, fallback: string) {
  return text.replace(/[\\/:*?"<>|#^[\]\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || fallback;
}

export async function ensureFolder(app: App, path: string) {
  let folder = '';
  for (const part of normalizePath(path).split('/')) {
    folder = folder ? `${folder}/${part}` : part;
    if (!(await app.vault.adapter.exists(folder))) await app.vault.createFolder(folder);
  }
}

export async function readState<T>(app: App, name: string, fallback: T): Promise<T> {
  const path = normalizePath(`${stateDir()}/${name}.json`);
  try {
    if (await app.vault.adapter.exists(path)) return { ...fallback, ...(JSON.parse(await app.vault.adapter.read(path)) as Partial<T>) };
  } catch {
    return fallback;
  }
  return fallback;
}

export async function writeState(app: App, name: string, value: unknown) {
  const adapter = app.vault.adapter;
  if (!(await adapter.exists(root))) await ensureFolder(app, root);
  if (!(await adapter.exists(stateDir()))) await adapter.mkdir(stateDir());
  await adapter.write(normalizePath(`${stateDir()}/${name}.json`), JSON.stringify(value));
}

export function linkTarget(source: Source) {
  const path = source.path.replace(/\.md$/i, '');
  return source.heading && !/[#|^[\]]/.test(source.heading) ? `${path}#${source.heading}` : path;
}

export function sourceLink(source: Source) {
  return `[[${linkTarget(source)}|${source.title.replace(/[[\]|]/g, ' ')}]]`;
}

export async function sourceTexts(app: App, sources: Source[]) {
  const texts = new Map<number, string>();
  for (const source of sources) {
    const file = app.vault.getAbstractFileByPath(source.path);
    if (file instanceof TFile) texts.set(source.n, `${source.title}\n${await app.vault.cachedRead(file)}`);
  }
  return texts;
}

export interface AiNote {
  folder: string;
  name: string;
  title: string;
  kind: string;
  body: string;
  sources: Source[];
  path?: string;
}

export async function writeAiNote(app: App, note: AiNote): Promise<TFile> {
  const texts = await sourceTexts(app, note.sources);
  const body = verifyAnswer(note.body, texts, (quote, ok, cite) => `「${quote}」${cite}${ok ? '' : '（原文里没找到）'}`).text;
  const cited = new Set([...body.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])));
  const sources = note.sources.filter((source) => cited.has(source.n));
  const other = note.sources.filter((source) => !cited.has(source.n));
  const parts = [
    '---',
    `title: ${JSON.stringify(note.title)}`,
    `type: ${note.kind}`,
    'source: ai',
    `created: ${today()}`,
    '---',
    '',
    '> [!ai] AI 根据你的笔记生成',
    '> [编号] 对应文末来源，「」是笔记原话，【推断】是 AI 补充的判断。',
    '',
    body.trim()
  ];
  if (sources.length) parts.push('', '### 来源', '', ...sources.map((source) => `- [${source.n}] ${sourceLink(source)}`));
  if (other.length) parts.push('', '### 也参考了', '', ...other.map((source) => `- [${source.n}] ${sourceLink(source)}`));
  const content = `${parts.join('\n')}\n`;
  await ensureFolder(app, note.folder);
  if (note.path) {
    const existing = app.vault.getAbstractFileByPath(note.path);
    if (existing instanceof TFile) {
      await app.vault.modify(existing, content);
      return existing;
    }
    return app.vault.create(note.path, content);
  }
  let path = normalizePath(`${note.folder}/${stamp()} ${safeName(note.name, note.kind)}.md`);
  for (let i = 2; app.vault.getAbstractFileByPath(path); i++) path = normalizePath(`${note.folder}/${stamp()} ${safeName(note.name, note.kind)}-${i}.md`);
  return app.vault.create(path, content);
}
