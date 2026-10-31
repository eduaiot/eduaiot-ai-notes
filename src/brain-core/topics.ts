import { jsonList } from './json';
import type { Message } from './llm';
import { seeded, type Random } from './random';
import { normalize } from './vectors';

export interface Topic {
  id: number;
  paths: string[];
  centroid: Float32Array;
}

export interface Bridge {
  a: string;
  b: string;
  ta: number;
  tb: number;
  score: number;
}

export interface Item {
  path: string;
  vector: Float32Array;
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

export function topicCount(notes: number): number {
  return Math.max(2, Math.min(12, Math.round(Math.sqrt(notes / 2))));
}

export function kmeans(items: Item[], k: number, random: Random = seeded('topics'), minSize = 3): Topic[] {
  if (!items.length) return [];
  const size = Math.min(k, items.length);
  const centroids: Float32Array[] = [items[Math.floor(random() * items.length)].vector];
  const nearest = new Float64Array(items.length).fill(Infinity);
  while (centroids.length < size) {
    const last = centroids[centroids.length - 1];
    let total = 0;
    items.forEach((item, i) => {
      nearest[i] = Math.min(nearest[i], Math.max(0, 1 - dot(item.vector, last)));
      total += nearest[i] * nearest[i];
    });
    if (!total) break;
    let target = random() * total;
    let index = 0;
    for (; index < items.length - 1; index++) {
      target -= nearest[index] * nearest[index];
      if (target <= 0) break;
    }
    centroids.push(items[index].vector);
  }
  const assign = new Int32Array(items.length).fill(-1);
  for (let round = 0; round < 20; round++) {
    let changed = false;
    items.forEach((item, i) => {
      let best = 0;
      let score = -Infinity;
      centroids.forEach((centroid, j) => {
        const value = dot(item.vector, centroid);
        if (value > score) {
          score = value;
          best = j;
        }
      });
      if (assign[i] !== best) {
        assign[i] = best;
        changed = true;
      }
    });
    const sums = centroids.map((centroid) => new Float32Array(centroid.length));
    const counts = new Int32Array(centroids.length);
    items.forEach((item, i) => {
      const sum = sums[assign[i]];
      counts[assign[i]]++;
      for (let d = 0; d < sum.length; d++) sum[d] += item.vector[d];
    });
    sums.forEach((sum, j) => {
      if (counts[j]) centroids[j] = normalize(sum);
    });
    if (!changed) break;
  }
  const sizes = new Int32Array(centroids.length);
  assign.forEach((j) => sizes[j]++);
  const large = centroids.map((_, j) => j).filter((j) => sizes[j] >= minSize);
  if (large.length && large.length < centroids.length) {
    items.forEach((item, i) => {
      if (sizes[assign[i]] >= minSize) return;
      let best = large[0];
      let score = -Infinity;
      for (const j of large) {
        const value = dot(item.vector, centroids[j]);
        if (value > score) {
          score = value;
          best = j;
        }
      }
      assign[i] = best;
    });
  }
  return centroids
    .map((centroid, j) => ({
      centroid,
      members: items
        .filter((_, i) => assign[i] === j)
        .map((item) => ({ path: item.path, score: dot(item.vector, centroid) }))
        .sort((a, b) => b.score - a.score)
    }))
    .filter((group) => group.members.length)
    .sort((a, b) => b.members.length - a.members.length)
    .map((group, id) => ({ id, centroid: group.centroid, paths: group.members.map((member) => member.path) }));
}

export function bridges(topics: Topic[], vectorOf: (path: string) => Float32Array | null, limit = 6): Bridge[] {
  const found: Bridge[] = [];
  const closest = (topic: Topic, toward: Float32Array) => topic.paths
    .map((path) => ({ path, vector: vectorOf(path) }))
    .filter((item): item is Item => !!item.vector)
    .map((item) => ({ ...item, score: dot(item.vector, toward) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);
  for (let i = 0; i < topics.length; i++) {
    for (let j = i + 1; j < topics.length; j++) {
      const left = closest(topics[i], topics[j].centroid);
      const right = closest(topics[j], topics[i].centroid);
      let best: Bridge | null = null;
      for (const a of left) {
        for (const b of right) {
          const score = dot(a.vector, b.vector);
          if (!best || score > best.score) best = { a: a.path, b: b.path, ta: topics[i].id, tb: topics[j].id, score };
        }
      }
      if (best) found.push(best);
    }
  }
  const used = new Set<string>();
  const out: Bridge[] = [];
  for (const bridge of found.sort((a, b) => b.score - a.score)) {
    if (used.has(bridge.a) || used.has(bridge.b)) continue;
    used.add(bridge.a);
    used.add(bridge.b);
    out.push(bridge);
    if (out.length >= limit) break;
  }
  return out;
}

export interface TopicName {
  name: string;
  summary: string;
}

const NAMING = `你是笔记整理助手。下面是用户的笔记按内容自动分成的几组，每组列出了最有代表性的几篇笔记（标题和开头内容）。
请为每组写：
- name：4 到 10 个字，概括这组笔记共同的核心内容，要具体，不同组的名字要能一眼区分，不要用「其他」「杂项」「主题」这类词。
- summary：一句话（30 字以内），说清楚这组笔记主要在讲什么。
只输出 JSON 数组，不要输出别的内容，格式：[{"id":0,"name":"核心概要","summary":"一句话"}]，id 用每组前面的编号。`;

export interface NamingGroup {
  id: number;
  notes: { title: string; preview: string }[];
}

export function namingMessages(groups: NamingGroup[]): Message[] {
  const user = groups
    .map((group) => `第 ${group.id} 组：\n${group.notes.map((note) => `- ${note.title}${note.preview ? `：${note.preview}` : ''}`).join('\n')}`)
    .join('\n\n');
  return [
    { role: 'system', content: NAMING },
    { role: 'user', content: user }
  ];
}

export function parseNames(text: string, ids: number[]): Map<number, TopicName> {
  const out = new Map<number, TopicName>();
  const list = jsonList(text).filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && typeof (item as Record<string, unknown>).name === 'string');
  const raw = list.map((item) => Number(item.id));
  const oneBased = raw.every(Number.isFinite) && !raw.includes(0) && raw.every((id) => ids.includes(id - 1));
  list.forEach((item, i) => {
    let id = Number(item.id);
    if (!Number.isFinite(id) || !ids.includes(oneBased ? id - 1 : id)) id = ids[i];
    else if (oneBased) id -= 1;
    const name = String(item.name).trim().replace(/^主题[:：]?/, '').slice(0, 20);
    if (id === undefined || !name || out.has(id)) return;
    out.set(id, { name, summary: typeof item.summary === 'string' ? item.summary.trim().slice(0, 120) : '' });
  });
  return out;
}
