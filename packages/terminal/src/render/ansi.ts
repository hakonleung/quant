/**
 * ANSI escape sequences used by the terminal renderer.
 *
 * Lives under `lib/terminal/render` per CLAUDE.md §2.5.1 — pure module, no IO,
 * no React, no globals. Importing this from a unit test must produce stable,
 * deterministic strings.
 */

export const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  inverse: '\x1b[7m',

  // Foreground
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',

  // Bright FG
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightCyan: '\x1b[96m',

  // Background
  bgBlack: '\x1b[40m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgGray: '\x1b[100m',

  // Cursor / screen
  clear: '\x1b[2J\x1b[H',
  clearLine: '\x1b[2K',
  cursorHome: '\x1b[H',
} as const;

/** Wrap `text` with `seq` and reset, leaving plain strings untouched if `seq` is empty. */
export function paint(text: string, ...seq: readonly string[]): string {
  if (seq.length === 0) return text;
  return `${seq.join('')}${text}${ANSI.reset}`;
}

/** Strip ANSI for width calculations. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}
