import type { ContextGroup } from './engine';
import type { Message } from './llm';
import { notesBlock } from './skills';

export const PROFILE_SECTIONS = ['关注的领域', '正在做的事', '工具和技能', '内容风格和偏好', '目标和计划'];
export const CONFIRMED = '✅';
export const INFERRED = '🤖';

export interface ProfileItem {
  section: string;
  text: string;
  evidence: string;
  confirmed: boolean;
  line: number;
  raw: string;
}

export interface ProfileSuggestion {
  section: string;
  text: string;
  evidence: number[];
}

const ITEM = /^\s*[-*]\s+(?:(✅|🤖)\s*)?(.+?)\s*$/;
const EVIDENCE = /（依据：(.+)）$/;

export function profileSkeleton(): string {
  return [
    '---',
    'type: ai-profile',
    '---',
    '',
    '> [!ai] 这是 AI 对你的了解，问答和技能会参考这里。',
    `> ${CONFIRMED} 是你确认过的，${INFERRED} 是 AI 从笔记里推断、还没确认的，只有 ${CONFIRMED} 和你自己写的条目会被使用。`,
    '> 可以直接修改、删除，也可以自己加一行「- 内容」，自己写的条目算作已确认。',
    '',
    ...PROFILE_SECTIONS.flatMap((section) => [`### ${section}`, '', ''])
  ].join('\n');
}

export function normalizeProfileText(text: string): string {
  return text.replace(EVIDENCE, '').replace(/[\s，。、；：,.;:!！?？「」"'（）()]/g, '').toLowerCase();
}

export function parseProfile(text: string): ProfileItem[] {
  const items: ProfileItem[] = [];
  let section = '';
  text.split(/\r?\n/).forEach((raw, line) => {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(raw);
    if (heading) {
      section = heading[1].replace(/^[\d.]+\s*/, '');
      return;
    }
    if (!section) return;
    const match = ITEM.exec(raw);
    if (!match) return;
    const body = match[2];
    const evidence = EVIDENCE.exec(body)?.[1] ?? '';
    items.push({ section, text: body.replace(EVIDENCE, '').trim(), evidence, confirmed: match[1] !== INFERRED, line, raw });
  });
  return items;
}

export function confirmedProfile(items: ProfileItem[]): string {
  const sections = new Map<string, string[]>();
  for (const item of items) {
    if (!item.confirmed || !item.text) continue;
    const list = sections.get(item.section) ?? [];
    list.push(`- ${item.text}`);
    sections.set(item.section, list);
  }
  return [...sections].map(([section, list]) => `${section}：\n${list.join('\n')}`).join('\n');
}

const SYSTEM = `你是用户的笔记助手，负责从用户的笔记里总结「用户是什么样的人」，补充到他的个人画像里。必须遵守：
1. 只能根据参考笔记推断，每条都要给出依据的笔记编号，没有依据的不要写。
2. 每条一句话，写具体的事实或倾向，比如「在做面向家长的编程启蒙课」，不要写空泛的话。
3. 不要重复「已有画像」和「用户否定过」里的内容，也不要换个说法重复。
4. 收藏的内容不等于用户本人的观点，判断时要区分「用户收藏了什么」和「用户自己在做什么」。
5. 最多 {{max}} 条，宁缺毋滥；尽量覆盖参考笔记里出现的不同领域，不要都集中在一个方面。
6. 只输出 JSON 数组，不要输出别的内容，格式：[{"section":"分类","text":"一句话","evidence":[1,3]}]
分类只能从这些里选：${PROFILE_SECTIONS.join('、')}。`;

export const INTERVIEW: { section: string; question: string; placeholder: string }[] = [
  { section: '正在做的事', question: '你现在主要在做什么？', placeholder: '比如：做少儿编程课程、开发一个微信小程序、运营红酒短视频账号' },
  { section: '关注的领域', question: '你最关注哪几个领域？', placeholder: '比如：AI 教育、智能硬件、短剧创作' },
  { section: '目标和计划', question: '接下来想用笔记产出什么？', placeholder: '比如：每周两条短视频、一门课程、一篇公众号' },
  { section: '工具和技能', question: '你常用哪些工具，或者擅长什么？', placeholder: '比如：剪映、Arduino、Python、Obsidian' },
  { section: '内容风格和偏好', question: '你喜欢什么样的内容或表达方式？', placeholder: '比如：实操步骤多、少讲概念、口语化' }
];

export function interviewLines(answers: Record<string, string>): { section: string; line: string }[] {
  return INTERVIEW.flatMap((item) => (answers[item.section] ?? '')
    .split(/\n+/)
    .map((text) => text.trim().replace(/^[-*]\s*/, ''))
    .filter(Boolean)
    .map((text) => ({ section: item.section, line: `- ${CONFIRMED} ${text.slice(0, 200)}` })));
}

export function profileMessages(current: ProfileItem[], rejected: string[], groups: ContextGroup[], max = 8): Message[] {
  const existing = current.map((item) => `- [${item.section}] ${item.text}`).join('\n') || '（还没有）';
  const user = [
    `## 已有画像\n${existing}`,
    rejected.length ? `## 用户否定过\n${rejected.map((text) => `- ${text}`).join('\n')}` : '',
    `## 参考笔记\n${notesBlock(groups)}`
  ].filter(Boolean).join('\n\n');
  return [
    { role: 'system', content: SYSTEM.replace('{{max}}', String(max)) },
    { role: 'user', content: user }
  ];
}

export function parseSuggestions(text: string, max: number, limit = 8): ProfileSuggestion[] {
  const body = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1] ?? text;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const list: unknown = JSON.parse(body.slice(start, end + 1));
    if (!Array.isArray(list)) return [];
    return (list as { text?: unknown; section?: unknown; evidence?: unknown }[])
      .filter((item) => typeof item?.text === 'string' && item.text.trim() && typeof item.section === 'string' && PROFILE_SECTIONS.includes(item.section))
      .map((item) => ({
        section: item.section as string,
        text: (item.text as string).trim().replace(/\n/g, ' ').slice(0, 120),
        evidence: Array.isArray(item.evidence) ? (item.evidence as unknown[]).filter((n): n is number => typeof n === 'number' && n >= 1 && n <= max) : []
      }))
      .filter((item) => item.evidence.length)
      .slice(0, limit);
  } catch {
    return [];
  }
}

export function insertProfileItems(text: string, items: { section: string; line: string }[]): string {
  const lines = text.split(/\r?\n/);
  for (const section of PROFILE_SECTIONS) {
    const add = items.filter((item) => item.section === section).map((item) => item.line);
    if (!add.length) continue;
    let at = lines.findIndex((line) => /^#{1,6}\s+/.test(line) && line.replace(/^#{1,6}\s+/, '').replace(/^[\d.]+\s*/, '').trim() === section);
    if (at < 0) {
      while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
      lines.push('', `### ${section}`, '');
      at = lines.length - 2;
    }
    let end = at + 1;
    while (end < lines.length && !/^#{1,6}\s+/.test(lines[end])) end++;
    let last = end;
    while (last > at + 1 && !lines[last - 1].trim()) last--;
    lines.splice(last, 0, ...add);
  }
  return lines.join('\n');
}
