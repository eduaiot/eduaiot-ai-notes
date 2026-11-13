export interface Chunk {
  heading: string;
  trail: string;
  text: string;
  line: number;
}

const MAX = 800;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
const AI_CALLOUT = /^\s*>\s*\[!ai\]/i;
const MARKS = ['\n', '。', '！', '？', '；', '. ', '! ', '? '];

function split(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > MAX) {
    let cut = -1;
    for (const mark of MARKS) {
      const at = rest.lastIndexOf(mark, MAX);
      if (at > MAX / 2 && at + mark.length > cut) cut = at + mark.length;
    }
    if (cut < 0) cut = MAX;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) out.push(rest);
  return out;
}

export function chunkNote(body: string, firstLine = 0): Chunk[] {
  const chunks: Chunk[] = [];
  const stack: string[] = [];
  let parts: string[] = [];
  let size = 0;
  let start = firstLine;
  let para: string[] = [];
  let paraStart = firstLine;
  let fenced = false;
  let aiBlock = false;

  const emit = (text: string, line: number) => {
    const clean = text.trim();
    if (clean.replace(/\s/g, '').length < 4) return;
    chunks.push({
      heading: stack[stack.length - 1] ?? '',
      trail: stack.filter(Boolean).join(' / '),
      text: clean,
      line
    });
  };
  const flush = () => {
    if (parts.length) emit(parts.join('\n\n'), start);
    parts = [];
    size = 0;
  };
  const endPara = () => {
    if (!para.length) return;
    const text = para.join('\n');
    para = [];
    if (text.length > MAX) {
      flush();
      for (const piece of split(text)) emit(piece, paraStart);
      return;
    }
    if (size && size + text.length > MAX) flush();
    if (!parts.length) start = paraStart;
    parts.push(text);
    size += text.length;
  };

  body.split(/\r?\n/).forEach((line, i) => {
    if (!fenced && (AI_CALLOUT.test(line) || (aiBlock && /^\s*>/.test(line)))) {
      if (!aiBlock) endPara();
      aiBlock = true;
      return;
    }
    aiBlock = false;
    if (FENCE.test(line)) fenced = !fenced;
    const heading = fenced ? null : HEADING.exec(line);
    if (heading) {
      endPara();
      flush();
      const level = heading[1]!.length;
      stack.length = level - 1;
      stack[level - 1] = heading[2]!;
      return;
    }
    if (!fenced && !line.trim()) {
      endPara();
      return;
    }
    if (!para.length) paraStart = firstLine + i;
    para.push(line);
  });
  endPara();
  flush();
  return chunks;
}
