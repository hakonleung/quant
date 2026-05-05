'use client';

/**
 * Big block-letter "qX//OS_" logo for TERM.MAIN, drawn as ASCII pixel
 * art. Each glyph is a 7-row × 7-column matrix of `█` and ` ` (space),
 * doubled horizontally (each filled cell is rendered as `██`) so the
 * resulting pixels read as tall, tile-shaped blocks rather than thin
 * verticals — matches the reference (docs/CRT Terminal -
 * standalone.html, zoomed-in capture).
 *
 * Layout:
 *   q  X  /  /  O  S  _      ← 7 glyphs
 *   each 14 cells wide       (7 cols × 2)
 *   1-cell gap between       → total 14·7 + 6 = 104 cells/row
 *   7 rows tall
 *
 * The trailing `_` glyph blinks via the global `@keyframes blink`. We
 * render two stacked <pre> blocks: the static body (without the
 * underscore), and a copy that includes only the underscore — the
 * latter has the blink animation applied to its ENTIRE block, which is
 * fine because the rest of its cells are blank.
 */

import { Box } from '@chakra-ui/react';

type Glyph = readonly [string, string, string, string, string, string, string];

// 7-row × 7-col glyphs. `█` = pixel on, ` ` = pixel off.
const Q: Glyph = [
  '       ',
  ' █████ ',
  '█     █',
  '█     █',
  ' ██████',
  '      █',
  '   ████',
];
const X_: Glyph = [
  '       ',
  '█     █',
  ' █   █ ',
  '  █ █  ',
  '   █   ',
  '  █ █  ',
  ' █   █ ',
];
const SL: Glyph = [
  '      █',
  '     █ ',
  '    █  ',
  '   █   ',
  '  █    ',
  ' █     ',
  '█      ',
];
const O_: Glyph = [
  '       ',
  ' █████ ',
  '█     █',
  '█     █',
  '█     █',
  '█     █',
  ' █████ ',
];
const S_: Glyph = [
  '       ',
  ' ██████',
  '█      ',
  ' █████ ',
  '      █',
  '      █',
  '██████ ',
];
const BLANK: Glyph = ['       ', '       ', '       ', '       ', '       ', '       ', '       '];
const UND: Glyph = [
  '       ',
  '       ',
  '       ',
  '       ',
  '       ',
  '       ',
  '███████',
];

/** Render a row by joining glyphs with a 1-col gap. Filled cells are
 * doubled horizontally so the visual tile aspect matches the design
 * reference (cells appear as squares rather than thin verticals). */
function joinRow(row: number, glyphs: readonly Glyph[]): string {
  return glyphs.map((g) => double(g[row] ?? '')).join(' ');
}

function double(s: string): string {
  let out = '';
  for (const ch of s) out += ch === ' ' ? '  ' : '██';
  return out;
}

const STATIC_GLYPHS: readonly Glyph[] = [Q, X_, SL, SL, O_, S_, BLANK];
const CURSOR_GLYPHS: readonly Glyph[] = [BLANK, BLANK, BLANK, BLANK, BLANK, BLANK, UND];

const STATIC_BODY = [0, 1, 2, 3, 4, 5, 6].map((r) => joinRow(r, STATIC_GLYPHS)).join('\n');
const CURSOR_BODY = [0, 1, 2, 3, 4, 5, 6].map((r) => joinRow(r, CURSOR_GLYPHS)).join('\n');

export function BigLogo(): React.ReactElement {
  return (
    <Box position="relative" lineHeight="0.85" userSelect="none">
      <Box
        as="pre"
        fontFamily="mono"
        fontSize={{ base: '7px', md: '9px', lg: '11px', xl: '13px' }}
        color="term.green"
        textShadow="0 0 4px rgba(94,255,156,0.55), 0 0 12px rgba(94,255,156,0.25), 0 0 22px rgba(94,255,156,0.12)"
        letterSpacing="0"
        margin={0}
      >
        {STATIC_BODY}
      </Box>
      <Box
        as="pre"
        position="absolute"
        inset="0"
        fontFamily="mono"
        fontSize={{ base: '7px', md: '9px', lg: '11px', xl: '13px' }}
        color="term.green"
        textShadow="0 0 4px rgba(94,255,156,0.55), 0 0 12px rgba(94,255,156,0.25)"
        letterSpacing="0"
        margin={0}
        css={{ animation: 'blink 1s steps(1) infinite' }}
        pointerEvents="none"
      >
        {CURSOR_BODY}
      </Box>
    </Box>
  );
}
