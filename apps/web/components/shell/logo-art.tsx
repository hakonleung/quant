'use client';

/**
 * Shared `qX//OS_` ASCII pixel-art logo. Two stacked `<pre>` layers in
 * the same monospace grid:
 *
 *   1. STATIC body  — `qX//OS` block without the trailing cursor cell
 *   2. CURSOR layer — blank rows 1..4 and a `████████` block on row 5
 *      with a global `blink` animation; only rendered when
 *      `showCursor` is true (term-mode only)
 *
 * One source of truth for the ASCII grid. Two render sites use it:
 *
 *   - TopBar Brand   — small / no cursor / no glow
 *   - BigLogo (TERM) — large / cursor / green CRT glow
 *
 * Pure presentational — accepts size + color tokens, never reads stores
 * or globals (CLAUDE.md §2.5.1).
 */

import { Box } from '@chakra-ui/react';

export const LOGO_STATIC_BODY = `  ██████  ██    ██       //  ██████  ███████
 ██    ██  ██  ██      //   ██    ██ ██
 ██    ██   ████     //     ██    ██ ███████
 ████████  ██  ██   //       ██    ██      ██
       ██ ██    ██ //         ██████  ███████`;

// Same column grid as STATIC_BODY — only the trailing `_` cell on row 5
// carries pixels. Blinking the entire <pre> is fine because every other
// cell is blank.
export const LOGO_CURSOR_BODY = `



                                              ████████`;

export const LOGO_FONT = `"Space Mono", ui-monospace, Menlo, monospace`;

interface LogoArtProps {
  /** CSS color for both static body and cursor. */
  readonly color: string;
  /** Font size in CSS pixels. The grid scales linearly with this. */
  readonly fontSize: string;
  /** Line height as a unitless multiplier (default `1.05`). */
  readonly lineHeight?: string;
  /** Inter-character letter spacing (default `1px`). */
  readonly letterSpacing?: string;
  /** Optional CSS `text-shadow` for the CRT glow. */
  readonly textShadow?: string;
  /** When true (default), renders the blinking cursor block. */
  readonly showCursor?: boolean;
}

export function LogoArt({
  color,
  fontSize,
  lineHeight = '1.05',
  letterSpacing = '1px',
  textShadow,
  showCursor = true,
}: LogoArtProps): React.ReactElement {
  const layerStyle = {
    margin: 0,
    fontFamily: LOGO_FONT,
    color,
    fontSize,
    lineHeight,
    letterSpacing,
    ...(textShadow === undefined ? {} : { textShadow }),
    whiteSpace: 'pre' as const,
    userSelect: 'none' as const,
  };
  return (
    <Box position="relative" display="inline-block">
      <Box as="pre" {...layerStyle}>
        {LOGO_STATIC_BODY}
      </Box>
      {showCursor && (
        <Box
          as="pre"
          position="absolute"
          inset="0"
          pointerEvents="none"
          css={{ animation: 'blink 1s steps(1) infinite' }}
          {...layerStyle}
        >
          {LOGO_CURSOR_BODY}
        </Box>
      )}
    </Box>
  );
}
