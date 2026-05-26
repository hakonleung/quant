/**
 * Maps the workbench theme mode to an xterm.js `ITheme`. The result is
 * meant to be assigned to `Terminal.options.theme` at runtime — xterm
 * applies the new colours without tearing down the instance or losing
 * the scroll buffer.
 *
 * Pure: no IO, no globals, no DOM access. Reads only from
 * `palette.xterm.light` / `palette.xterm.dark` — a dedicated 16-slot
 * ANSI palette that's intentionally different from the workbench
 * `term.*` semantic tokens. The workbench `term.*` tokens now alias
 * the regular workbench palette so panels look unified, while xterm
 * itself keeps a "real terminal" aesthetic — light = Solarized
 * cream (the canonical rice-paper terminal), dark = 焦墨 with
 * 月白 foreground + 朱砂 cursor (mirrors the workbench 水墨月夜).
 */

import type { ITheme } from '@xterm/xterm';

import type { ThemeMode } from '@quant/shared';

import { palette } from './tokens.js';

const { xterm } = palette;

export function buildXtermTheme(mode: ThemeMode): ITheme {
  const p = mode === 'dark' ? xterm.dark : xterm.light;
  return {
    background: p.bg,
    foreground: p.ink,
    cursor: p.cursor,
    cursorAccent: p.cursorAccent,
    selectionBackground: p.selection,

    black: p.black,
    red: p.red,
    green: p.green,
    yellow: p.yellow,
    blue: p.blue,
    magenta: p.magenta,
    cyan: p.cyan,
    white: p.white,

    brightBlack: p.brightBlack,
    brightRed: p.brightRed,
    brightGreen: p.brightGreen,
    brightYellow: p.brightYellow,
    brightBlue: p.brightBlue,
    brightMagenta: p.brightMagenta,
    brightCyan: p.brightCyan,
    brightWhite: p.brightWhite,
  };
}
