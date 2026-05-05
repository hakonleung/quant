/**
 * Tiny shlex-style argv parser for terminal commands.
 *
 * Supports:
 *   - Single & double quoted strings (no escape sequences inside single)
 *   - Backslash escapes outside quotes ("\\ " → literal space)
 *   - `--key=value` and `--key value` flag forms (positional vs flag is
 *     decided by the caller)
 *
 * Returns positional args + a parsed flag map. Booleans are inferred when a
 * `--flag` is followed by another `--flag` or end-of-input.
 *
 * Pure module (CLAUDE.md §2.5.1).
 */

export interface ParsedArgv {
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string | boolean>>;
}

export class ArgvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArgvParseError';
  }
}

export function tokenize(line: string): readonly string[] {
  const out: string[] = [];
  let buf = '';
  let i = 0;
  let inSingle = false;
  let inDouble = false;
  let hasContent = false;

  const flush = (): void => {
    if (hasContent || buf.length > 0) {
      out.push(buf);
      buf = '';
      hasContent = false;
    }
  };

  while (i < line.length) {
    const ch = line[i] as string;

    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
        hasContent = true;
      } else {
        buf += ch;
      }
      i += 1;
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
        hasContent = true;
      } else if (ch === '\\' && i + 1 < line.length) {
        buf += line[i + 1] as string;
        i += 2;
        continue;
      } else {
        buf += ch;
      }
      i += 1;
      continue;
    }

    if (ch === ' ' || ch === '\t') {
      flush();
      i += 1;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      i += 1;
      continue;
    }
    if (ch === '\\' && i + 1 < line.length) {
      buf += line[i + 1] as string;
      i += 2;
      continue;
    }
    buf += ch;
    i += 1;
  }
  if (inSingle || inDouble) {
    throw new ArgvParseError('unterminated quote');
  }
  flush();
  return out;
}

/**
 * Split a tokenized argv into positional arguments and a flag map.
 * `--key=value` is parsed eagerly; a bare `--key` consumes the next token
 * unless it's another flag, in which case it becomes a boolean.
 */
export function parseArgv(tokens: readonly string[]): ParsedArgv {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] as string;
    if (t.startsWith('--')) {
      const body = t.slice(2);
      if (body.length === 0) {
        // bare `--` → end of flags, rest are positional
        for (let j = i + 1; j < tokens.length; j += 1) {
          positional.push(tokens[j] as string);
        }
        break;
      }
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const next = tokens[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[body] = true;
      } else {
        flags[body] = next;
        i += 1;
      }
      continue;
    }
    positional.push(t);
  }

  return { positional, flags };
}

/** One-shot helper combining `tokenize` + `parseArgv`. */
export function parseLine(line: string): ParsedArgv {
  return parseArgv(tokenize(line));
}
