import { tokenize } from './text';

const K1 = 1.2;
const B = 0.75;
const BOOST = 2;
const MAX_TERMS = 48;

export interface Scored {
  id: number;
  score: number;
}

export class KeywordIndex {
  private readonly postings = new Map<string, Map<number, number>>();
  private readonly terms = new Map<number, string[]>();
  private readonly lengths = new Map<number, number>();
  private total = 0;

  add(id: number, text: string, boost = '') {
    this.remove(id);
    const tf = new Map<string, number>();
    for (const token of tokenize(text)) tf.set(token, (tf.get(token) ?? 0) + 1);
    for (const token of tokenize(boost)) tf.set(token, (tf.get(token) ?? 0) + BOOST);
    let length = 0;
    for (const [token, count] of tf) {
      length += count;
      let list = this.postings.get(token);
      if (!list) this.postings.set(token, (list = new Map<number, number>()));
      list.set(id, count);
    }
    this.terms.set(id, [...tf.keys()]);
    this.lengths.set(id, length);
    this.total += length;
  }

  remove(id: number) {
    const terms = this.terms.get(id);
    if (!terms) return;
    for (const token of terms) {
      const list = this.postings.get(token);
      if (!list) continue;
      list.delete(id);
      if (!list.size) this.postings.delete(token);
    }
    this.total -= this.lengths.get(id) ?? 0;
    this.terms.delete(id);
    this.lengths.delete(id);
  }

  search(query: string, limit: number): Scored[] {
    const count = this.lengths.size;
    if (!count) return [];
    const average = this.total / count;
    const lists = [...new Set(tokenize(query))]
      .map((token) => this.postings.get(token))
      .filter((list): list is Map<number, number> => !!list)
      .sort((a, b) => a.size - b.size)
      .slice(0, MAX_TERMS);
    const scores = new Map<number, number>();
    for (const list of lists) {
      const idf = Math.log(1 + (count - list.size + 0.5) / (list.size + 0.5));
      for (const [id, freq] of list) {
        const length = this.lengths.get(id) ?? average;
        const score = idf * (freq * (K1 + 1)) / (freq + K1 * (1 - B + B * length / average));
        scores.set(id, (scores.get(id) ?? 0) + score);
      }
    }
    return [...scores].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score).slice(0, limit);
  }
}
