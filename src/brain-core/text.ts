const WORD = /[a-z0-9][a-z0-9_.+-]*|[\u3400-\u9fff\uf900-\ufaff]+/g;
const CJK = /^[\u3400-\u9fff\uf900-\ufaff]/;
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const match of text.toLowerCase().matchAll(WORD)) {
    const word = match[0];
    if (CJK.test(word)) {
      if (word.length === 1) out.push(word);
      for (let i = 0; i < word.length - 1; i++) out.push(word.slice(i, i + 2));
    } else if (word.length >= 2) {
      out.push(word);
    }
  }
  return out;
}

export function hash(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export interface ParsedNote {
  frontmatter: Record<string, string>;
  body: string;
  bodyLine: number;
}

function scalar(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try {
      return String(JSON.parse(value));
    } catch {
      return value.replace(/^"|"$/g, '');
    }
  }
  if (value.startsWith("'")) return value.replace(/^'|'$/g, '').replace(/''/g, "'");
  return value;
}

export function parseNote(text: string): ParsedNote {
  const match = FRONTMATTER.exec(text);
  if (!match) return { frontmatter: {}, body: text, bodyLine: 0 };
  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) frontmatter[kv[1]] = scalar(kv[2]);
  }
  return { frontmatter, body: text.slice(match[0].length), bodyLine: match[0].split('\n').length - 1 };
}

export function basename(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.md$/i, '');
}

export function noteTitle(title: string | undefined, path: string): string {
  const clean = (title ?? '').split('\n')[0].replace(/#[^\s#]+/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.replace(/\s/g, '').length >= 4 ? clean.slice(0, 80) : basename(path);
}

export function compact(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
