interface Packed {
  q: Int8Array;
  s: number;
}

export interface VectorMeta {
  model: string;
  dim: number;
  keys: string[];
}

export function normalize(vector: ArrayLike<number>): Float32Array {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += vector[i]! * vector[i]!;
  const norm = Math.sqrt(sum) || 1;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = vector[i]! / norm;
  return out;
}

export class VectorStore {
  model = '';
  dim = 0;
  private items = new Map<string, Packed>();

  get size() {
    return this.items.size;
  }

  has(key: string) {
    return this.items.has(key);
  }

  clear(model = this.model) {
    this.items.clear();
    this.model = model;
    this.dim = 0;
  }

  set(key: string, vector: ArrayLike<number>) {
    if (!this.dim) this.dim = vector.length;
    if (vector.length !== this.dim) throw new Error(`向量长度不一致：${vector.length} / ${this.dim}`);
    const unit = normalize(vector);
    let max = 0;
    for (let i = 0; i < unit.length; i++) max = Math.max(max, Math.abs(unit[i]!));
    const s = max / 127 || 1;
    const q = new Int8Array(unit.length);
    for (let i = 0; i < unit.length; i++) q[i] = Math.round(unit[i]! / s);
    this.items.set(key, { q, s });
  }

  get(key: string): Float32Array | null {
    const item = this.items.get(key);
    if (!item) return null;
    const out = new Float32Array(item.q.length);
    for (let i = 0; i < out.length; i++) out[i] = item.q[i]! * item.s;
    return out;
  }

  score(query: Float32Array, key: string): number | null {
    const item = this.items.get(key);
    if (!item || query.length !== item.q.length) return null;
    let dot = 0;
    for (let i = 0; i < query.length; i++) dot += query[i]! * item.q[i]!;
    return dot * item.s;
  }

  retain(keys: Set<string>) {
    for (const key of [...this.items.keys()]) if (!keys.has(key)) this.items.delete(key);
  }

  encode(): { meta: VectorMeta; data: ArrayBuffer } {
    const keys = [...this.items.keys()];
    const data = new ArrayBuffer(keys.length * 4 + keys.length * this.dim);
    const scales = new Float32Array(data, 0, keys.length);
    const values = new Int8Array(data, keys.length * 4);
    keys.forEach((key, i) => {
      const item = this.items.get(key)!;
      scales[i] = item.s;
      values.set(item.q, i * this.dim);
    });
    return { meta: { model: this.model, dim: this.dim, keys }, data };
  }

  load(meta: VectorMeta, data: ArrayBuffer) {
    this.clear(meta.model);
    const count = meta.keys.length;
    if (!count || data.byteLength !== count * 4 + count * meta.dim) return;
    this.dim = meta.dim;
    const scales = new Float32Array(data.slice(0, count * 4));
    const values = new Int8Array(data, count * 4);
    meta.keys.forEach((key, i) => {
      this.items.set(key, { q: values.slice(i * meta.dim, (i + 1) * meta.dim), s: scales[i]! });
    });
  }
}
