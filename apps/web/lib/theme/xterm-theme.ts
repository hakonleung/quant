/**
 * Maps the workbench theme mode to an xterm.js `ITheme`. The result is
 * meant to be assigned to `Terminal.options.theme` at runtime — xterm
 * applies the new colours without tearing down the instance or losing
 * the scroll buffer.
 *
 * Pure: no IO, no globals, no DOM access. Reads only from
 * `palette.term` / `palette.termLight` (the canonical 16-slot ANSI
 * source in `tokens.ts`).
 *
 * See THEME_DESIGN.md §5 for the slot table.
 */

import type { ITheme } from '@xterm/xterm';

import type { ThemeMode } from '@quant/shared';

import { palette } from './tokens.js';

const { term, termLight } = palette;

export function buildXtermTheme(mode: ThemeMode): ITheme {
  // Pick the source palette up-front so the slot map below reads as
  // a flat lookup; bright variants intentionally mirror their non-bright
  // counterparts (the design only specifies 8 ANSI hues, doubled).
  const p = mode === 'dark' ? term : termLight;

  // Selection background in light mode needs a paler tint than
  // `greenDark` (which is the dark-mode pick) so it doesn't read as
  // a solid block over the text. `#c5d8c9` is the desaturated forest
  // counterpart called out in THEME_DESIGN.md §5.
  const selectionBackground = mode === 'dark' ? p.greenDark : '#c5d8c9';

  // brightBlack is the only slot whose "bright" variant is meaningfully
  // distinct from non-bright (it's the dim grey for muted prompts).
  const brightBlack = mode === 'dark' ? p.ink3 : '#8a9aaa';

  return {
    background: p.bg,
    foreground: p.ink,
    cursor: p.green,
    cursorAccent: p.bg,
    selectionBackground,

    black: p.panel,
    red: p.red,
    green: p.green,
    yellow: p.amber,
    blue: p.cyan,
    magenta: p.magenta,
    cyan: p.cyan,
    white: p.ink,

    brightBlack,
    brightRed: p.red,
    brightGreen: p.green,
    brightYellow: p.amber,
    brightBlue: p.cyan,
    brightMagenta: p.magenta,
    brightCyan: p.cyan,
    brightWhite: p.ink,
  };
}
