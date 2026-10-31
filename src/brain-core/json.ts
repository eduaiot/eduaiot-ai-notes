export function jsonList(text: string): unknown[] {
  const body = (/```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1] ?? text).replace(/<think>[\s\S]*?<\/think>/g, '');
  const candidates = [body.slice(body.indexOf('['), body.lastIndexOf(']') + 1), body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const value: unknown = JSON.parse(candidate);
      if (Array.isArray(value)) return value;
      if (value && typeof value === 'object') {
        const inner = Object.values(value).find(Array.isArray);
        if (inner) return inner as unknown[];
      }
    } catch {
      continue;
    }
  }
  return [];
}
