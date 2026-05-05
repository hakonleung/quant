/**
 * Display-width utilities for monospace rendering with CJK support.
 * Pure module — no IO, no globals. Lives under `lib/terminal/render` per CLAUDE.md §2.5.1.
 *
 * The width model:
 *   - East Asian Wide / Fullwidth → 2 columns
 *   - Combining marks / zero-width → 0 columns
 *   - Everything else → 1 column
 *
 * We deliberately avoid `Intl.Segmenter`-based grapheme clustering here: most
 * cells we render are codes, names, and numbers, none of which use modifier
 * sequences. Per-codepoint width is enough and survives jsdom (which ships
 * `Intl.Segmenter` only on recent versions).
 */

import { stripAnsi } from './ansi.js';

/** Width of a single Unicode codepoint in monospace columns. */
function codepointWidth(cp: number): number {
  // C0 controls / DEL: 0
  if (cp < 0x20 || cp === 0x7f) return 0;

  // Combining marks (a coarse but adequate cover of common BMP ranges)
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe20 && cp <= 0xfe2f)
  ) {
    return 0;
  }

  // East Asian Wide / Fullwidth ranges (subset; covers CJK + fullwidth ASCII)
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK Radicals Supplement … CJK Symbols
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana, Katakana, Bopomofo, Hangul Compat, CJK Strokes, …
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compat Ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK Compat Forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth ASCII variants
    (cp >= 0xffe0 && cp <= 0xffe6)
  ) {
    return 2;
  }

  return 1;
}

/** Visual columns occupied by a string (ANSI codes are stripped first). */
export function visualWidth(s: string): number {
  const plain = stripAnsi(s);
  let w = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    w += codepointWidth(cp);
  }
  return w;
}

/**
 * Pad `s` to `width` visual columns with `ch`. ANSI is preserved verbatim.
 * If `s` is already wider, returns it unchanged (caller is expected to
 * `truncate` first when a hard ceiling is required).
 */
export function padEnd(s: string, width: number, ch: string = ' '): string {
  const w = visualWidth(s);
  if (w >= width) return s;
  return s + ch.repeat(width - w);
}

export function padStart(s: string, width: number, ch: string = ' '): string {
  const w = visualWidth(s);
  if (w >= width) return s;
  return ch.repeat(width - w) + s;
}

/**
 * Truncate `s` so its visual width does not exceed `max`. Adds an ellipsis
 * (`…`, 1 column) when truncation occurs, unless `max < 1`.
 */
export function truncate(s: string, max: number): string {
  if (max <= 0) return '';
  const plain = stripAnsi(s);
  if (visualWidth(plain) <= max) return plain;
  if (max === 1) return '…';
  let acc = '';
  let used = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    const cw = codepointWidth(cp);
    if (used + cw > max - 1) break;
    acc += ch;
    used += cw;
  }
  return acc + '…';
}
