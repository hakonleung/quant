/**
 * Tokenizes the `rest` string of a parsed instruction line (everything
 * after the leading `<id>` token) into a `Record<string, string>` ready
 * for `zod.safeParse`. The grammar is deliberately small:
 *
 *   - whitespace separates tokens
 *   - `key=value` pairs always set the named key
 *   - bare positionals consume the next slot in `spec.positional`, in
 *     order, and skip any key already filled by an explicit `k=v`
 *   - double-quoted values support `\"` and `\\` escapes; everything
 *     else is verbatim
 *
 * It does NOT do zod validation or coercion — the executor calls
 * `argsSchema.safeParse` afterwards.
 */

export class ArgvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgvParseError';
  }
}

function isWs(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n';
}

interface CursorResult {
  readonly value: string;
  readonly next: number;
}

function consumeQuoted(rest: string, start: number): CursorResult {
  let i = start;
  const n = rest.length;
  let value = '';
  while (i < n) {
    const q = rest[i] ?? '';
    if (q === '\\' && i + 1 < n) {
      value += rest[i + 1] ?? '';
      i += 2;
      continue;
    }
    if (q === '"') return { value, next: i + 1 };
    value += q;
    i += 1;
  }
  throw new ArgvParseError('unterminated quoted value');
}

function consumeToken(rest: string, start: number): CursorResult {
  let i = start;
  const n = rest.length;
  let value = '';
  while (i < n) {
    const c = rest[i] ?? '';
    if (isWs(c)) break;
    if (c === '"') {
      const inner = consumeQuoted(rest, i + 1);
      value += inner.value;
      i = inner.next;
      continue;
    }
    value += c;
    i += 1;
  }
  return { value, next: i };
}

export function tokenize(rest: string): readonly string[] {
  const out: string[] = [];
  let i = 0;
  const n = rest.length;
  while (i < n) {
    const ch = rest[i] ?? '';
    if (isWs(ch)) {
      i += 1;
      continue;
    }
    const r = consumeToken(rest, i);
    out.push(r.value);
    i = r.next;
  }
  return out;
}

export function parseArgvToObject(
  rest: string,
  positional: readonly string[] = [],
): Record<string, string> {
  const tokens = tokenize(rest);
  const out: Record<string, string> = {};
  let posIdx = 0;
  for (const token of tokens) {
    const eq = token.indexOf('=');
    if (eq > 0) {
      const key = token.slice(0, eq);
      const value = token.slice(eq + 1);
      out[key] = value;
      continue;
    }
    while (posIdx < positional.length) {
      const slot = positional[posIdx] ?? '';
      posIdx += 1;
      if (slot.length === 0) continue;
      if (Object.prototype.hasOwnProperty.call(out, slot)) continue;
      out[slot] = token;
      break;
    }
    // Extra positionals beyond the declared list are silently
    // dropped — the spec's zod schema will reject if it cared.
  }
  return out;
}
