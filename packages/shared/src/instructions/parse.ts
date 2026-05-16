/**
 * Shared shlex-style argv tokenizer + flag parser.
 *
 * Single source of truth for converting a raw command line into
 * `(positional, flags)`. Both FE (terminal) and BE (IM listener) call
 * this via the InstructionCenter's `dispatch` entry; per-instruction
 * argument coercion then runs through the manifest's `argsSchema`
 * (see `coerceArgs` in `center.ts`).
 *
 * Behaviour matches the terminal's historical parser
 * (`packages/terminal/src/engine/parse-argv.ts`):
 *   - Single & double quoted strings (no escape inside single)
 *   - Backslash escapes outside quotes (`"\\ "` → literal space)
 *   - `--key=value` and `--key value` flag forms
 *   - Bare `--` ends flag parsing; remainder is positional
 *   - `--flag` followed by another `--flag` or EOL → boolean true
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

export function parseArgv(tokens: readonly string[]): ParsedArgv {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] as string;
    if (t.startsWith('--')) {
      const body = t.slice(2);
      if (body.length === 0) {
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
