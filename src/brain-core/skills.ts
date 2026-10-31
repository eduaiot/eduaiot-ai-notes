import { INFER, profileBlock } from './ask';
import type { ContextGroup } from './engine';
import type { Message } from './llm';
import { basename, parseNote } from './text';

export type SkillScope = 'current' | 'recent' | 'sample' | 'pick' | 'cross' | 'search';

const SCOPES: SkillScope[] = ['current', 'recent', 'sample', 'pick', 'cross', 'search'];

export interface Skill {
  path: string;
  name: string;
  description: string;
  scope: SkillScope;
  days: number;
  limit: number;
  query: string;
  has: string;
  output: string;
  prompt: string;
}

function number(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseSkill(path: string, text: string): Skill | null {
  const { frontmatter, body } = parseNote(text);
  if (frontmatter.type !== 'ai-skill' || !body.trim()) return null;
  const scope = SCOPES.find((item) => item === frontmatter.scope) ?? 'current';
  return {
    path,
    name: frontmatter.name || basename(path),
    description: frontmatter.description ?? '',
    scope,
    days: number(frontmatter.days, 7),
    limit: Math.min(number(frontmatter.limit, 20), 60),
    query: frontmatter.query ?? '',
    has: frontmatter.has ?? '',
    output: frontmatter.output || '输出',
    prompt: body.trim()
  };
}

export const SKILL_SYSTEM = `你是用户的笔记助手，根据「参考笔记」完成「任务」。必须遵守：
1. 来自笔记的事实、观点、例子，句末用 [编号] 标出来源，例如 [1]、[2][3]。
2. 「」只用来引用笔记里一字不差的原话，后面跟编号。概括、改写、你自己的话都不要加「」。
3. 对用户本人的判断（兴趣、习惯、能力等），笔记里没有直接写的，单独成段，段首写「${INFER}」。
4. 你提出的建议、创意、选题可以不标编号，但不能说成是用户笔记里写的。
5. 不要编造笔记里没有的事实、数字、人名和链接。
6. 用中文和 Markdown，标题从 ### 开始，不要用一级和二级标题。
7. 「用户画像」是用户确认过的个人情况，用来让结果更贴合他，不能当作来源编号引用。`;

export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) => vars[key] ?? match);
}

export function notesBlock(groups: ContextGroup[], labels: Record<string, string> = {}): string {
  return groups
    .map(({ source, texts, current }) => {
      const tags = [current ? '用户正在看的笔记' : '', labels[source.path] ?? ''].filter(Boolean).join('，');
      return `[${source.n}] 《${source.title}》${tags ? `（${tags}）` : ''}\n${texts.join('\n\n')}`;
    })
    .join('\n\n---\n\n');
}

export function skillMessages(task: string, groups: ContextGroup[], selection = '', labels: Record<string, string> = {}, profile = ''): Message[] {
  const user = [
    `## 任务\n${task}`,
    profileBlock(profile),
    selection.trim() ? `## 重点\n用户选中了下面这段文字，请围绕它完成任务：\n${selection.trim().slice(0, 2000)}` : '',
    `## 参考笔记\n${notesBlock(groups, labels) || '（没有参考笔记）'}`
  ].filter(Boolean).join('\n\n');
  return [
    { role: 'system', content: SKILL_SYSTEM },
    { role: 'user', content: user }
  ];
}

export const INSPIRE_TASK = `下面每个「组合」是来自两个不同主题、但内容上有关联的笔记。请为每个组合写一张灵感卡，格式：

### 灵感 N：一句话标题
- 组合：哪两篇笔记的什么内容连在一起，标出来源
- 能做成什么：一个具体的作品、课程、工具或内容
- 为什么是我：结合笔记说明我已经有什么基础
- 30 分钟第一步：现在就能动手的一件小事

{{pairs}}`;

function preset(name: string, meta: Record<string, string | number>, prompt: string): { file: string; text: string } {
  const lines = ['---', 'type: ai-skill', `name: ${name}`, ...Object.entries(meta).map(([key, value]) => `${key}: ${value}`), '---', '', prompt.trim(), ''];
  return { file: `${name}.md`, text: lines.join('\n') };
}

export const PRESET_SKILLS = [
  preset('每周回顾', { description: '回顾最近 7 天记下和改过的笔记，整理成周报', scope: 'recent', days: 7, limit: 40, output: '周报' }, `
请根据参考笔记，为我写一份 {{range}} 的周报：

### 1. 这周记了什么
按主题归类，每个主题用一两句话说清楚记了什么。

### 2. 最值得再看的 3 条
挑出最有价值的 3 条，说明为什么值得再看。

### 3. 可以马上行动的
从笔记里找出能落地的事情，每条写清楚第一步做什么。

### 4. 下周建议
根据这周的内容，给出下周学习或创作的 2 到 3 条建议。`),
  preset('爆款规律', { description: '从收藏的短视频和文章里总结爆款的共同规律', scope: 'recent', days: 90, has: 'platform', limit: 30, output: '爆款规律' }, `
参考笔记是我收藏的短视频和文章（来自抖音、视频号、小红书、公众号等）。请总结它们为什么能火：

### 1. 开头怎么抓人
总结开头前几秒或第一段常用的手法，每种手法举 1 到 2 个例子。

### 2. 内容结构
总结常见的内容结构和节奏。

### 3. 选题和标题
总结选题方向和标题套路，引用原标题作例子。

### 4. 可以直接套用的模板
给出 3 个我可以直接套用的脚本模板，写清楚每个模板适合什么选题。`),
  preset('选题生成', { description: '根据最近 30 天的笔记生成 10 个能做的选题', scope: 'recent', days: 30, limit: 30, output: '选题' }, `
请根据参考笔记，为我生成 10 个可以做成内容的选题。输出形式可以是短视频、公众号文章、课程或小程序工具。

每个选题按这个格式：

### 选题 N：标题
- 为什么适合我：结合我的笔记说明
- 可以用的素材：列出能直接用的笔记编号
- 建议形式：短视频、文章、课程、工具选一个，并说明理由
- 第一步：30 分钟内能做的事`),
  preset('多篇合稿', { description: '把选中的几篇笔记合成一篇文章草稿', scope: 'pick', limit: 10, output: '草稿' }, `
请把参考笔记合成一篇完整的文章草稿：

1. 先用一句话写出这篇文章的核心观点。
2. 设计清晰的结构，用 ### 小标题分段。
3. 正文尽量保留笔记里的原话和例子，用「」引用并标出来源。
4. 段落之间补上过渡，补充的内容不要编造事实。
5. 最后给出 3 个备选标题。`),
  preset('灵感卡', { description: '把当前笔记和其他领域的笔记结合，生成灵感卡', scope: 'cross', limit: 5, output: '灵感' }, `
[1] 是我正在看的笔记，其他是我在不同领域记过的相关笔记。请把它们结合起来，生成 3 张灵感卡：

### 灵感 N：一句话标题
- 组合：哪几篇笔记的什么内容结合在一起
- 能做成什么：一个具体的作品、课程、工具或内容
- 为什么是我：结合笔记说明我已经有什么基础
- 30 分钟第一步：现在就能动手的一件小事`)
];
