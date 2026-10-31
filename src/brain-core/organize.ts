import { jsonList } from './json';
import type { Message } from './llm';

const POOR = /^(未命名|无标题|untitled|新建|新笔记|笔记\s*\d*$)/i;

export function poorTitle(name: string): boolean {
  const title = name.trim();
  return title.length < 2 || POOR.test(title) || /^[\d\s\-_.年月日时分秒:：]+$/.test(title);
}

export interface OrganizeInput {
  n: number;
  title: string;
  folder: string;
  tags: string[];
  text: string;
  related: { key: string; path: string; title: string }[];
}

export interface OrganizeResult {
  summary: string;
  tags: string[];
  folder: string;
  title: string;
  links: string[];
}

const SYSTEM = `你是笔记整理助手，帮用户整理笔记，不改正文。对每篇笔记给出：
- summary：一句话摘要，40 字以内，说清楚这篇讲了什么。
- tags：3 到 5 个标签，要准确描述这篇讲的内容（领域、主题、用途）。「已有标签」里有意思相同的就用已有的写法，没有就新建；不要硬套不相关的已有标签。标签 2 到 8 个字，不带 #，不含空格。
- folder：从「已有文件夹」里选一个最适合放这篇的；现在的位置已经合适就填现在的文件夹；都不合适填空字符串。
- title：只有当前标题是「未命名」、纯日期或看不出内容时，才给一个 6 到 20 字的新标题，否则填空字符串。
- links：从这篇的「候选相关笔记」里挑出内容确实相关、值得互相链接的，填它们的字母；没有就填空数组。
只输出 JSON 数组，不要输出别的内容，格式：[{"n":1,"summary":"…","tags":["…"],"folder":"…","title":"","links":["a"]}]`;

export function organizeMessages(notes: OrganizeInput[], tags: string[], folders: string[]): Message[] {
  const blocks = notes.map((note) => [
    `### 笔记 ${note.n}`,
    `标题：${note.title}`,
    `现在的文件夹：${note.folder || '（根目录）'}`,
    `现有标签：${note.tags.join('、') || '无'}`,
    `候选相关笔记：${note.related.map((item) => `${item.key}) 《${item.title}》`).join('；') || '无'}`,
    `内容：\n${note.text}`
  ].join('\n'));
  const user = [
    `## 已有标签\n${tags.slice(0, 150).join('、') || '（还没有）'}`,
    `## 已有文件夹\n${folders.slice(0, 100).join('\n') || '（只有根目录）'}`,
    `## 笔记\n${blocks.join('\n\n')}`
  ].join('\n\n');
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user }
  ];
}

export interface PlanFolder {
  path: string;
  from: string[];
  desc: string;
}

export interface FolderSummary {
  path: string;
  count: number;
  titles: string[];
}

const PLAN = `你是笔记整理顾问。根据用户现有的文件夹和笔记，设计一套清晰好找的分类文件夹结构。要求：
1. 尽量保留用户现有的文件夹和命名习惯（比如「01-」这样的编号前缀），只在确实需要时才改名、合并或新建。
2. 最多两层，一级文件夹 4 到 10 个。
3. 每个文件夹写一句说明：放什么样的笔记。
4. from 填哪些现有文件夹的笔记归到这里：保持不变就填它自己；改名就填原来的路径；几个合并成一个就都填上；新建的填空数组。现有文件夹都要有去处，除非它本来就合适而且你没有列出它的上级。
5. 根目录下散落的笔记不用写进 from，之后会逐篇分配。
6. 「受保护的文件夹」是其他插件或 Obsidian 设置在用的，必须原样保留（path 和 from 都是它自己），不能改名、不能合并到别处。
只输出 JSON 数组，不要输出别的内容，格式：[{"path":"01-项目","from":["01-项目"],"desc":"一句话说明"}]`;

export function planMessages(folders: FolderSummary[], loose: FolderSummary, topics: { name: string; summary: string; count: number }[], locked: string[] = [], base = ''): Message[] {
  const lines = folders.map((folder) => `- ${folder.path}（${folder.count} 篇）：${folder.titles.join('；') || '空'}`);
  const user = [
    base ? `## 整理范围\n只整理「${base}」文件夹内部：按笔记的内容（主题、用途）在「${base}」里设计 3 到 8 个子分类，所有 path 都必须在「${base}/」下面（相对「${base}」最多两层），from 也只能是「${base}」里面的文件夹，不要涉及别的文件夹。按日期或月份命名的文件夹（比如 2026-10）和附件文件夹只是归档方式，不是分类，不要写进方案，也不要作为 from；这里不要求保留现有的子文件夹。` : '',
    `## 现有文件夹\n${lines.join('\n') || '（没有文件夹）'}`,
    locked.length ? `## 受保护的文件夹\n${locked.map((folder) => `- ${folder}`).join('\n')}` : '',
    `## ${base ? `「${base}」里的全部笔记` : '根目录下散落的笔记'}（${loose.count} 篇）\n${loose.titles.join('；') || '无'}`,
    topics.length ? `## AI 按内容分出的主题\n${topics.map((topic) => `- ${topic.name}（${topic.count} 篇）：${topic.summary}`).join('\n')}` : ''
  ].filter(Boolean).join('\n\n');
  return [
    { role: 'system', content: PLAN },
    { role: 'user', content: user }
  ];
}

export function cleanFolder(path: string, depth = 2): string {
  return path
    .split('/')
    .map((part) => part.replace(/[\\:*?"<>|#^[\]\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, depth)
    .join('/');
}

const ARCHIVE = /^(\d{4}([-_.年]\d{1,2}月?)?([-_.月]\d{1,2}日?)?([-_ ]?old)?|附件|attachments?|assets)$/i;

export function archiveFolder(path: string): boolean {
  return ARCHIVE.test(path.split('/').pop() ?? '');
}

export function sanitizePlan(plan: PlanFolder[]): PlanFolder[] {
  const uses = new Map<string, number>();
  for (const folder of plan) for (const from of new Set(folder.from)) uses.set(from, (uses.get(from) ?? 0) + 1);
  return plan.map((folder) => ({
    ...folder,
    from: [...new Set(folder.from)].filter((from) => from === folder.path || (!archiveFolder(from) && (uses.get(from) ?? 0) < 2))
  }));
}

export function parsePlan(text: string, existing: string[], base = ''): PlanFolder[] {
  const known = new Set(existing);
  const out: PlanFolder[] = [];
  const depth = base ? base.split('/').length + 2 : 2;
  for (const item of jsonList(text)) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    let raw = String(record.path ?? '').trim().replace(/^\/+|\/+$/g, '');
    if (base && raw !== base && !raw.startsWith(`${base}/`)) raw = `${base}/${raw}`;
    const path = cleanFolder(raw, depth);
    if (!path || out.some((folder) => folder.path === path)) continue;
    const from = (Array.isArray(record.from) ? record.from : typeof record.from === 'string' ? [record.from] : [])
      .map((value) => String(value).trim().replace(/^\/+|\/+$/g, ''))
      .filter((value) => known.has(value));
    out.push({ path, from: [...new Set(from)], desc: typeof record.desc === 'string' ? record.desc.trim().slice(0, 80) : '' });
  }
  return out;
}

const CLASSIFY = `你是笔记分类助手。给每篇笔记选一个最合适的分类：
1. 按笔记正文主要在讲什么来判断，不要只看标题里的字眼或标签；一篇笔记涉及好几个方面时，选它最核心的那个。
2. 每篇只能选一个分类，填分类的编号；没有一个分类合适时填 0，表示留在原处。
只输出 JSON 数组，不要输出别的内容，格式：[{"n":1,"c":2}]`;

export function classifyMessages(categories: { path: string; desc: string }[], notes: { n: number; title: string; text: string }[]): Message[] {
  const user = [
    `## 分类\n${categories.map((category, i) => `${i + 1}. ${category.path.split('/').pop()}：${category.desc || '（无说明）'}`).join('\n')}`,
    `## 笔记\n${notes.map((note) => `### 笔记 ${note.n}\n标题：${note.title}\n内容：\n${note.text}`).join('\n\n')}`
  ].join('\n\n');
  return [
    { role: 'system', content: CLASSIFY },
    { role: 'user', content: user }
  ];
}

export function parseClassify(text: string, notes: number, categories: number): Map<number, number> {
  const out = new Map<number, number>();
  jsonList(text).forEach((item, i) => {
    if (!item || typeof item !== 'object') return;
    const record = item as Record<string, unknown>;
    const n = Number(record.n ?? i + 1);
    const c = Number(record.c ?? record.category ?? 0);
    if (Number.isInteger(n) && n >= 1 && n <= notes && Number.isInteger(c) && c >= 0 && c <= categories && !out.has(n)) out.set(n, c);
  });
  return out;
}

export interface Cut {
  from: number;
  to: number;
  first: string;
  last: string;
  lines: number;
}

function loose(text: string): string {
  return text.replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function findCuts(text: string, start: string, end: string, headingOnly: boolean): Cut[] {
  const head = loose(start);
  const tail = loose(end);
  if (!head || !tail) return [];
  const lines = text.split('\n');
  let begin = 0;
  if (lines[0]?.trim() === '---') {
    const close = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
    if (close > 0) begin = close + 1;
  }
  const cuts: Cut[] = [];
  for (let i = begin; i < lines.length; i++) {
    if (!loose(lines[i]).includes(head) || (headingOnly && !/^\s*#{1,6}\s/.test(lines[i]))) continue;
    let j = i;
    while (j < lines.length && !loose(lines[j]).includes(tail)) j++;
    if (j >= lines.length) break;
    cuts.push({ from: i, to: j, first: lines[i].trim(), last: lines[j].trim(), lines: j - i + 1 });
    i = j;
  }
  return cuts;
}

export function applyCuts(text: string, cuts: Cut[]): string {
  if (!cuts.length) return text;
  const lines = text.split('\n');
  const blank = (i: number) => i >= 0 && i < lines.length && !lines[i].trim();
  for (const cut of [...cuts].sort((a, b) => b.from - a.from)) {
    lines.splice(cut.from, cut.to - cut.from + 1);
    while (blank(cut.from - 1) && blank(cut.from)) lines.splice(cut.from, 1);
  }
  while (lines.length > 1 && blank(lines.length - 1) && blank(lines.length - 2)) lines.pop();
  return lines.join('\n');
}

export function cleanTag(tag: string): string {
  return tag.trim().replace(/^#+/, '').replace(/\s+/g, '-').replace(/[,，、;；#"'`[\]{}()（）]/g, '').slice(0, 30);
}

export function cleanTitle(title: string): string {
  return title.replace(/[\\/:*?"<>|#^[\]\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
}

export function parseOrganize(text: string, notes: OrganizeInput[], folders: string[]): Map<number, OrganizeResult> {
  const out = new Map<number, OrganizeResult>();
  const known = new Set(folders);
  const list = jsonList(text).filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
  list.forEach((item, i) => {
    const n = Number(item.n);
    const note = notes.find((entry) => entry.n === n) ?? notes[i];
    if (!note || out.has(note.n)) return;
    const folder = typeof item.folder === 'string' ? item.folder.trim().replace(/^\/+|\/+$/g, '') : '';
    const keys = Array.isArray(item.links) ? item.links.map((key) => String(key).trim().toLowerCase().replace(/[)）.]/g, '')) : [];
    out.set(note.n, {
      summary: typeof item.summary === 'string' ? item.summary.trim().replace(/\n/g, ' ').slice(0, 120) : '',
      tags: [...new Set((Array.isArray(item.tags) ? item.tags : []).map((tag) => cleanTag(String(tag))).filter(Boolean))].slice(0, 5),
      folder: known.has(folder) ? folder : '',
      title: typeof item.title === 'string' ? cleanTitle(item.title) : '',
      links: note.related.filter((related) => keys.includes(related.key)).map((related) => related.path)
    });
  });
  return out;
}
