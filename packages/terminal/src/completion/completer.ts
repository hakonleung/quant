/**
 * Pure command-name / sub-command / parameter completer for the terminal.
 *
 * Given the current input buffer + cursor + the registered command names,
 * returns the candidate list and the buffer-mutation hint when the user
 * hits Tab. Per-command parameter completers (e.g. stock code completion)
 * are looked up via the `paramCompleter` callback so the completer itself
 * has no IO and stays under `lib/terminal/completion`.
 *
 * Pure (CLAUDE.md §2.5.1).
 */

export interface CompletionCandidate {
  readonly insert: string;
  readonly label: string;
}

export interface CompletionResult {
  /** Common prefix that can be inserted unconditionally. */
  readonly commonPrefix: string;
  readonly candidates: readonly CompletionCandidate[];
  /** Range of the buffer to replace with `insert + (commonPrefix - existing)`. */
  readonly tokenStart: number;
  readonly tokenEnd: number;
}

export type ParamCompleter = (
  command: string,
  positionalIdx: number,
  fragment: string,
) => readonly CompletionCandidate[];

export interface CompleterEnv {
  readonly commands: readonly string[];
  /** Sub-commands per command, e.g. {stock:['find','info','kline']}. */
  readonly subcommands: Readonly<Record<string, readonly string[]>>;
  readonly paramCompleter?: ParamCompleter;
}

/**
 * `complete()` is called when the user hits Tab. It looks at the buffer
 * up to `cursor`, decides whether the active token is a command name,
 * subcommand, or positional arg, and returns suitable candidates.
 */
export function complete(buffer: string, cursor: number, env: CompleterEnv): CompletionResult {
  const upTo = buffer.slice(0, cursor);
  const tokenStart = lastTokenStart(upTo);
  const fragment = upTo.slice(tokenStart);
  const tokenEnd = cursor;
  const tokens = upTo.slice(0, tokenStart).trim().split(/\s+/u).filter((t) => t.length > 0);

  let candidates: readonly CompletionCandidate[];
  if (tokens.length === 0) {
    candidates = env.commands
      .filter((c) => c.startsWith(fragment))
      .map((c) => ({ insert: c, label: c }));
  } else {
    const cmd = tokens[0] as string;
    const subs = env.subcommands[cmd];
    if (tokens.length === 1 && subs !== undefined) {
      candidates = subs
        .filter((s) => s.startsWith(fragment))
        .map((s) => ({ insert: s, label: s }));
    } else {
      const positionalIdx = subs !== undefined ? Math.max(0, tokens.length - 2) : tokens.length - 1;
      candidates =
        env.paramCompleter !== undefined
          ? env.paramCompleter(cmd, positionalIdx, fragment)
          : [];
    }
  }

  const commonPrefix = sharedPrefix(candidates.map((c) => c.insert));
  return { commonPrefix, candidates, tokenStart, tokenEnd };
}

function lastTokenStart(s: string): number {
  for (let i = s.length - 1; i >= 0; i -= 1) {
    const ch = s[i] as string;
    if (ch === ' ' || ch === '\t') return i + 1;
  }
  return 0;
}

function sharedPrefix(arr: readonly string[]): string {
  if (arr.length === 0) return '';
  let prefix = arr[0] as string;
  for (let i = 1; i < arr.length; i += 1) {
    const cur = arr[i] as string;
    let j = 0;
    while (j < prefix.length && j < cur.length && prefix[j] === cur[j]) j += 1;
    prefix = prefix.slice(0, j);
    if (prefix.length === 0) break;
  }
  return prefix;
}
