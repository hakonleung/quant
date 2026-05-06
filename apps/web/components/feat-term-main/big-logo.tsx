'use client';

/**
 * Big "qX//OS _" ASCII art logo for TERM.MAIN.
 *
 * Two stacked <pre> layers in the same monospace grid:
 *
 *   1. STATIC body:  qX//OS without trailing cursor
 *   2. CURSOR layer: blank rows 1..4 plus a `████████` block on row 5
 *      positioned right after the `S`, with a global blink animation
 *
 * Style tokens (font / color / glow / letter-spacing) are copied verbatim
 * from the CRT-terminal HTML reference so the logo reads identically to
 * the reference design.
 */

import { Box } from '@chakra-ui/react';

const STATIC_BODY = `  ██████  ██    ██       //  ██████  ███████
 ██    ██  ██  ██      //   ██    ██ ██
 ██    ██   ████     //     ██    ██ ███████
 ████████  ██  ██   //       ██    ██      ██
       ██ ██    ██ //         ██████  ███████`;

// Same column grid as STATIC_BODY — only the trailing `_` cell on row 5
// carries pixels. Blinking the entire <pre> is fine because every other
// cell is blank.
const CURSOR_BODY = `



                                              ████████`;

const LOGO_FONT = `"Space Mono", ui-monospace, Menlo, monospace`;
const LOGO_COLOR = '#d4ffe2';
const LOGO_GLOW =
  'rgba(155, 242, 182, 0.8) 0px 0px 4px, rgba(155, 242, 182, 0.4) 0px 0px 12px, rgba(155, 242, 182, 0.2) 0px 0px 28px';

export function BigLogo(): React.ReactElement {
  const layerStyle = {
    margin: 0,
    fontFamily: LOGO_FONT,
    color: LOGO_COLOR,
    fontSize: '11.05px',
    lineHeight: '1.05',
    letterSpacing: '1px',
    textShadow: LOGO_GLOW,
    whiteSpace: 'pre' as const,
    userSelect: 'none' as const,
  };
  return (
    <Box position="relative">
      <Box as="pre" {...layerStyle}>
        {STATIC_BODY}
      </Box>
      <Box
        as="pre"
        position="absolute"
        inset="0"
        pointerEvents="none"
        css={{ animation: 'blink 1s steps(1) infinite' }}
        {...layerStyle}
      >
        {CURSOR_BODY}
      </Box>
    </Box>
  );
}
