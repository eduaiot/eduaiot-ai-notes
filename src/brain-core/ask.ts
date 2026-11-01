import type { ContextGroup } from './engine';
import type { Message } from './llm';

export const INFER = '【推断】';
export const NOT_FOUND = '你的笔记里没有找到相关内容';

export const ASK_SYSTEM = `你是用户的笔记助手，只根据「参考笔记」回答问题。必须遵守：
1. 标注了「用户正在看的笔记」的那篇，是问题里「这篇」「这个视频」「核心」「作者」等说法默认指的对象，优先依据它回答；其他笔记只在确实相关时作补充，并说明是另一篇笔记。
2. 来自笔记的每一句话，句末用 [编号] 标出来源，例如 [1]、[2][3]。
3. 「」只用来引用笔记里一字不差的原话，后面跟编号，例如「原话」[1]。概括、改写、术语、你自己的说法都不要加「」。
4. 笔记里没有、由你推理或补充的内容，单独成段，段首写「${INFER}」；这类段落里不要出现「」。
5. 参考笔记和问题无关时，先回答「${NOT_FOUND}」，需要时再用「${INFER}」段落给一般性建议。
6. 不要编造笔记里没有的事实、数字、人名和链接。
7. 用中文回答，简洁，用 Markdown，不要用一级和二级标题。
8. 「用户画像」是用户确认过的个人情况，只用来理解他的背景、让回答更贴合他，不能当作来源编号引用。`;

export function profileBlock(profile: string): string {
  return profile.trim() ? `## 用户画像\n${profile.trim().slice(0, 3000)}` : '';
}

export interface Turn {
  q: string;
  a: string;
}

export function askMessages(question: string, history: Turn[], groups: ContextGroup[], profile = ''): Message[] {
  const notes = groups
    .map(({ source, texts, current }) => `[${source.n}] 《${source.title}》${current ? '（用户正在看的笔记）' : ''}\n${texts.join('\n\n')}`)
    .join('\n\n---\n\n');
  const recent = history.slice(-3);
  const user = [
    profileBlock(profile),
    `## 参考笔记\n${notes || '（没有找到相关笔记）'}`,
    recent.length ? `## 之前的对话\n${recent.map((turn) => `问：${turn.q.slice(0, 500)}\n答：${turn.a.slice(0, 1000)}`).join('\n\n')}` : '',
    `## 问题\n${question.slice(0, 2000)}`
  ].filter(Boolean).join('\n\n');
  return [
    { role: 'system', content: ASK_SYSTEM },
    { role: 'user', content: user }
  ];
}

const QUOTE = /「([^」\n]{2,300})」((?:\s*\[\d+\])*)/g;

function plain(text: string): string {
  return text.replace(/[\s*_`>#~=[\]]/g, '').toLowerCase();
}

function found(quote: string, texts: string[]): boolean {
  const parts = quote.split(/……|\.\.\.|…/).map(plain).filter((part) => part.length >= 2);
  if (!parts.length) return true;
  return texts.some((text) => {
    const target = plain(text);
    return parts.every((part) => target.includes(part));
  });
}

export interface Verified {
  text: string;
  quotes: number;
  failed: number;
}

export function verifyAnswer(answer: string, sources: ReadonlyMap<number, string>, wrap: (quote: string, ok: boolean, cite: string) => string): Verified {
  let quotes = 0;
  let failed = 0;
  const text = answer.replace(QUOTE, (_, quote: string, cite: string) => {
    const numbers = [...cite.matchAll(/\d+/g)].map((match) => Number(match[0]));
    const pool = numbers.length ? numbers.map((n) => sources.get(n) ?? '') : [...sources.values()];
    const ok = found(quote, pool);
    quotes++;
    if (!ok) failed++;
    return wrap(quote, ok, cite);
  });
  return { text, quotes, failed };
}

export function locateQuote(text: string, quote: string): number {
  const first = quote.split(/……|\.\.\.|…/).map(plain).find((part) => part.length >= 2);
  if (!first) return -1;
  const lines = text.split(/\r?\n/);
  const probe = first.slice(0, 12);
  const head = probe.slice(0, 6);
  for (let i = 0; i < lines.length; i++) {
    if (plain(lines[i]).includes(head) && plain(lines.slice(i, i + 3).join('')).includes(probe)) return i;
  }
  return -1;
}

export function citedNumbers(answer: string): Set<number> {
  return new Set([...answer.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1])));
}
