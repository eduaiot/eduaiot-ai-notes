import { chunkNote, type Chunk } from './chunk';
import { KeywordIndex, type Scored } from './keyword';
import { basename, compact, hash, noteTitle, parseNote, tokenize } from './text';
import { normalize, VectorStore } from './vectors';

const RRF = 60;
const POOL = 100;
const EMBED_LIMIT = 1200;
const RELATED_TEXT = 1500;
const PIN_BUDGET = 6000;

function embedText(title: string, chunk: Chunk): string {
  return `${title}\n${chunk.trail}\n${chunk.text}`.slice(0, EMBED_LIMIT);
}

function labeled(chunk: Chunk): string {
  return chunk.trail ? `（${chunk.trail}）\n${chunk.text}` : chunk.text;
}

export interface PinnedNote {
  path: string;
  text: string;
}

export interface ChunkRecord {
  id: number;
  path: string;
  heading: string;
  trail: string;
  text: string;
  line: number;
  key: string;
}

interface NoteRecord {
  path: string;
  title: string;
  mtime: number;
  created: number;
  meta: Record<string, string>;
  ids: number[];
}

export interface NoteSummary {
  path: string;
  title: string;
  mtime: number;
  created: number;
  meta: Record<string, string>;
}

export interface Hit {
  path: string;
  title: string;
  heading: string;
  line: number;
  snippet: string;
  score: number;
}

export interface Source {
  n: number;
  path: string;
  title: string;
  heading: string;
  line?: number;
}

export interface ContextGroup {
  source: Source;
  texts: string[];
  current: boolean;
  picked?: boolean;
}

export interface Scope {
  refs?: PinnedNote[];
  folders?: string[];
}

function snippet(text: string, query: string): string {
  const lower = text.toLowerCase();
  let at = -1;
  for (const term of tokenize(query)) {
    const found = lower.indexOf(term);
    if (found >= 0 && (at < 0 || found < at)) at = found;
  }
  const start = Math.max(0, at - 40);
  return compact(text.slice(start, start + 160));
}

export class NoteEngine {
  readonly vectors = new VectorStore();
  private readonly notes = new Map<string, NoteRecord>();
  private readonly chunks = new Map<number, ChunkRecord>();
  private readonly keyword = new KeywordIndex();
  private nextId = 1;

  get noteCount() {
    return this.notes.size;
  }

  get chunkCount() {
    return this.chunks.size;
  }

  get embeddedCount() {
    let count = 0;
    for (const chunk of this.chunks.values()) if (this.vectors.has(chunk.key)) count++;
    return count;
  }

  paths(): string[] {
    return [...this.notes.keys()];
  }

  mtime(path: string): number | undefined {
    return this.notes.get(path)?.mtime;
  }

  title(path: string): string {
    return this.notes.get(path)?.title ?? basename(path);
  }

  set(path: string, mtime: number, text: string, ctime = mtime) {
    this.remove(path);
    const { frontmatter, body, bodyLine } = parseNote(text);
    const title = noteTitle(frontmatter.title, path);
    const created = Date.parse((frontmatter.created ?? '').replace(' ', 'T')) || ctime || mtime;
    const ids: number[] = [];
    if (frontmatter.source !== 'ai' && !(frontmatter.type ?? '').startsWith('ai-')) {
      for (const chunk of chunkNote(body, bodyLine)) {
        const id = this.nextId++;
        this.chunks.set(id, { id, path, ...chunk, key: hash(embedText(title, chunk)) });
        this.keyword.add(id, chunk.text, `${title} ${chunk.trail}`);
        ids.push(id);
      }
    }
    this.notes.set(path, { path, title, mtime, created, meta: frontmatter, ids });
  }

  list(): NoteSummary[] {
    const out: NoteSummary[] = [];
    for (const note of this.notes.values()) {
      if (note.ids.length) out.push({ path: note.path, title: note.title, mtime: note.mtime, created: note.created, meta: note.meta });
    }
    return out;
  }

  has(path: string): boolean {
    return !!this.notes.get(path)?.ids.length;
  }

  preview(path: string, length = 120): string {
    const note = this.notes.get(path);
    if (!note?.ids.length) return '';
    return compact(note.ids.map((id) => this.chunks.get(id)!.text).join(' ')).slice(0, length);
  }

  duplicates(threshold = 0.97, max = 2000): string[][] {
    const notes = this.list().map((note) => note.path);
    const parent = new Map(notes.map((path) => [path, path]));
    const root = (path: string): string => {
      let at = path;
      while (parent.get(at) !== at) at = parent.get(at)!;
      return at;
    };
    const join = (a: string, b: string) => parent.set(root(a), root(b));
    const exact = new Map<string, string>();
    for (const path of notes) {
      const key = hash(this.notes.get(path)!.ids.map((id) => this.chunks.get(id)!.text).join('\n'));
      const seen = exact.get(key);
      if (seen) join(path, seen);
      else exact.set(key, path);
    }
    if (notes.length <= max) {
      const vectors = notes.map((path) => ({ path, vector: this.noteVector(path) })).filter((item): item is { path: string; vector: Float32Array } => !!item.vector);
      for (let i = 0; i < vectors.length; i++) {
        for (let j = i + 1; j < vectors.length; j++) {
          const a = vectors[i].vector;
          const b = vectors[j].vector;
          let dot = 0;
          for (let d = 0; d < a.length; d++) dot += a[d] * b[d];
          if (dot >= threshold) join(vectors[i].path, vectors[j].path);
        }
      }
    }
    const groups = new Map<string, string[]>();
    for (const path of notes) {
      const key = root(path);
      groups.set(key, [...(groups.get(key) ?? []), path]);
    }
    return [...groups.values()].filter((group) => group.length > 1);
  }

  groups(paths: string[], pin: PinnedNote | null = null, budget = 24000): ContextGroup[] {
    const out: ContextGroup[] = [];
    const current = pin ? this.pinned(pin, '', null) : null;
    if (current) out.push(current);
    const rest = [...new Set(paths)].filter((path) => path !== pin?.path && this.has(path));
    const room = budget - (current ? PIN_BUDGET : 0);
    const per = Math.max(500, Math.min(3000, Math.floor(room / Math.max(rest.length, 1))));
    for (const path of rest) {
      const note = this.notes.get(path)!;
      const texts: string[] = [];
      let used = 0;
      for (const id of note.ids) {
        if (used >= per) break;
        const text = labeled(this.chunks.get(id)!).slice(0, per - used);
        texts.push(text);
        used += text.length;
      }
      out.push({ source: { n: out.length + 1, path, title: note.title, heading: '' }, texts, current: false });
    }
    return out;
  }

  remove(path: string) {
    const note = this.notes.get(path);
    if (!note) return;
    for (const id of note.ids) {
      this.keyword.remove(id);
      this.chunks.delete(id);
    }
    this.notes.delete(path);
  }

  embedInput(chunk: ChunkRecord): string {
    return embedText(this.title(chunk.path), chunk);
  }

  pending(): ChunkRecord[] {
    const seen = new Set<string>();
    const out: ChunkRecord[] = [];
    for (const chunk of this.chunks.values()) {
      if (this.vectors.has(chunk.key) || seen.has(chunk.key)) continue;
      seen.add(chunk.key);
      out.push(chunk);
    }
    return out;
  }

  prune() {
    this.vectors.retain(new Set([...this.chunks.values()].map((chunk) => chunk.key)));
  }

  private vectorSearch(query: Float32Array, limit: number, skip?: string, allow?: (path: string) => boolean): Scored[] {
    const out: Scored[] = [];
    for (const chunk of this.chunks.values()) {
      if (chunk.path === skip || (allow && !allow(chunk.path))) continue;
      const score = this.vectors.score(query, chunk.key);
      if (score !== null) out.push({ id: chunk.id, score });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private fuse(query: string, vector: Float32Array | null, skip?: string, allow?: (path: string) => boolean): ChunkRecord[] {
    const scores = new Map<number, number>();
    const add = (list: Scored[]) => list.forEach((item, rank) => scores.set(item.id, (scores.get(item.id) ?? 0) + 1 / (RRF + rank + 1)));
    const keep = (id: number) => {
      const path = this.chunks.get(id)?.path;
      return path !== undefined && path !== skip && (!allow || allow(path));
    };
    add(this.keyword.search(query, allow ? this.chunks.size : POOL).filter((item) => keep(item.id)).slice(0, POOL));
    if (vector && this.vectors.size) add(this.vectorSearch(vector, POOL, skip, allow));
    return [...scores]
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => this.chunks.get(id))
      .filter((chunk): chunk is ChunkRecord => !!chunk);
  }

  private hits(ranked: ChunkRecord[], query: string, limit: number): Hit[] {
    const out: Hit[] = [];
    const seen = new Set<string>();
    for (const chunk of ranked) {
      if (seen.has(chunk.path)) continue;
      seen.add(chunk.path);
      out.push({
        path: chunk.path,
        title: this.title(chunk.path),
        heading: chunk.heading,
        line: chunk.line,
        snippet: snippet(chunk.text, query),
        score: Math.round((1 - out.length / Math.max(limit, 1)) * 100) / 100
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  search(query: string, vector: Float32Array | null, limit = 10): Hit[] {
    return this.hits(this.fuse(query, vector), query, limit);
  }

  noteVector(path: string): Float32Array | null {
    const note = this.notes.get(path);
    if (!note?.ids.length) return null;
    let sum: Float32Array | null = null;
    for (const id of note.ids) {
      const vector = this.vectors.get(this.chunks.get(id)!.key);
      if (!vector) continue;
      if (!sum) sum = new Float32Array(vector.length);
      for (let i = 0; i < vector.length; i++) sum[i] += vector[i];
    }
    return sum ? normalize(sum) : null;
  }

  related(path: string, limit = 8): Hit[] {
    const note = this.notes.get(path);
    if (!note?.ids.length) return [];
    const text = `${note.title}\n${note.ids.map((id) => this.chunks.get(id)!.text).join('\n')}`.slice(0, RELATED_TEXT);
    return this.hits(this.fuse(text, this.noteVector(path), path), text, limit);
  }

  private pinned(pin: PinnedNote, query: string, vector: Float32Array | null, limit = PIN_BUDGET): ContextGroup | null {
    const { frontmatter, body, bodyLine } = parseNote(pin.text);
    const title = noteTitle(frontmatter.title, pin.path);
    const chunks = chunkNote(body, bodyLine);
    const head = [frontmatter.title, frontmatter.description, frontmatter.summary].filter(Boolean).join('\n');
    if (!chunks.length && !head) return null;
    let chosen = chunks;
    if (chunks.reduce((sum, chunk) => sum + chunk.text.length, 0) > limit) {
      const terms = new Set(tokenize(query));
      const score = (chunk: Chunk) => {
        const similar = vector ? this.vectors.score(vector, hash(embedText(title, chunk))) : null;
        if (similar !== null) return similar;
        const tokens = tokenize(chunk.text);
        return tokens.filter((token) => terms.has(token)).length / Math.sqrt(tokens.length || 1);
      };
      const ranked = chunks.map((chunk, i) => ({ chunk, i, score: i === 0 ? Infinity : score(chunk) })).sort((a, b) => b.score - a.score);
      const picked: typeof ranked = [];
      let used = 0;
      for (const item of ranked) {
        if (used + item.chunk.text.length > limit) continue;
        picked.push(item);
        used += item.chunk.text.length;
      }
      chosen = picked.sort((a, b) => a.i - b.i).map((item) => item.chunk);
    }
    const texts = chosen.map(labeled);
    if (head) texts.unshift(`（笔记属性）\n${head}`);
    return { source: { n: 1, path: pin.path, title, heading: '' }, texts, current: true };
  }

  context(query: string, vector: Float32Array | null, pin: PinnedNote | null = null, notes = 6, perNote = 2, budget = 9000, scope: Scope = {}): ContextGroup[] {
    const groups = new Map<string, ContextGroup>();
    let used = 0;
    const refs = (scope.refs ?? []).filter((ref) => ref.path !== pin?.path);
    const share = Math.max(1500, Math.floor((PIN_BUDGET * 2) / Math.max(1, refs.length + (pin ? 1 : 0))));
    const current = pin ? this.pinned(pin, query, vector, refs.length ? share : PIN_BUDGET) : null;
    if (current) groups.set(current.source.path, current);
    for (const ref of refs) {
      const group = this.pinned(ref, query, vector, share);
      if (group) groups.set(ref.path, { ...group, current: false, picked: true });
    }
    const folders = (scope.folders ?? []).map((folder) => folder.replace(/\/+$/, ''));
    const allow = folders.length ? (path: string) => folders.some((folder) => !folder || path.startsWith(`${folder}/`)) : undefined;
    const fixed = new Set(groups.keys());
    const limit = notes + refs.length;
    const take = (chunk: ChunkRecord) => {
      if (fixed.has(chunk.path)) return;
      let group = groups.get(chunk.path);
      if (!group) {
        if (groups.size >= limit) return;
        group = { source: { n: groups.size + 1, path: chunk.path, title: this.title(chunk.path), heading: chunk.heading, line: chunk.line }, texts: [], current: false };
        groups.set(chunk.path, group);
      }
      if (group.texts.length >= perNote || used + chunk.text.length > budget) return;
      group.texts.push(labeled(chunk));
      used += chunk.text.length;
    };
    for (const chunk of this.fuse(query, vector, pin?.path, allow).slice(0, POOL)) take(chunk);
    if (allow && groups.size === fixed.size) {
      for (const [path, note] of this.notes) {
        if (allow(path) && note.ids.length) take(this.chunks.get(note.ids[0])!);
      }
    }
    return [...groups.values()]
      .filter((group) => group.texts.length)
      .map((group, i) => ({ ...group, source: { ...group.source, n: i + 1 } }));
  }
}
