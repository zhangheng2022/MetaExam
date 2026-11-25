// Reject duplicate keys before JSON.parse. Depth and size are bounded by callers.
export function strictJson(text: string): unknown {
  let i = 0;
  function ws() {
    while (/\s/.test(text[i] ?? '') && i < text.length) i++;
  }
  function string(): string {
    const start = i++;
    while (i < text.length) {
      const ch = text[i++];
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '"') return JSON.parse(text.slice(start, i)) as string;
    }
    throw new Error('Unterminated string');
  }
  function value(depth: number): void {
    if (depth > 32) throw new Error('JSON too deep');
    ws();
    if (text[i] === '"') {
      string();
      return;
    }
    if (text[i] === '{') {
      i++;
      ws();
      const seen = new Set<string>();
      if (text[i] === '}') {
        i++;
        return;
      }
      while (i < text.length) {
        ws();
        if (text[i] !== '"') throw new Error('Expected key');
        const key = string();
        if (seen.has(key)) throw new Error('Duplicate key');
        seen.add(key);
        ws();
        if (text[i++] !== ':') throw new Error('Expected colon');
        value(depth + 1);
        ws();
        const next = text[i++];
        if (next === '}') return;
        if (next !== ',') throw new Error('Expected comma');
      }
    } else if (text[i] === '[') {
      i++;
      ws();
      if (text[i] === ']') {
        i++;
        return;
      }
      while (i < text.length) {
        value(depth + 1);
        ws();
        const next = text[i++];
        if (next === ']') return;
        if (next !== ',') throw new Error('Expected comma');
      }
    } else {
      const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
        text.slice(i),
      );
      if (!match) throw new Error('Invalid value');
      i += match[0].length;
      return;
    }
    throw new Error('Unexpected end');
  }
  value(0);
  ws();
  if (i !== text.length) throw new Error('Trailing data');
  return JSON.parse(text) as unknown;
}
