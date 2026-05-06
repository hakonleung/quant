'use client';

/**
 * CRT background — four stacked absolute-positioned layers copied from
 * the reference (docs/CRT Terminal - standalone.html). All four are
 * `pointer-events: none` so they never intercept clicks.
 *
 *   z=0  big 32x32 dim green grid (perspective lines)
 *   z=1  fine 3x3 green dot pattern (phosphor mesh)
 *   z=4  horizontal scanlines via repeating gradient (multiply blend)
 *   z=6  inner shadow + soft green glow (vignette)
 *
 * The intermediate z-bands (2,3,5) are reserved for the actual content
 * layers in `feat-term-main.tsx`, which sit between the dot mesh and
 * the scanline overlay so scanlines visibly cross over text.
 *
 * The base radial-gradient that gives the "screen-glow center" effect
 * is set as the parent container's `bg` (see `feat-term-main.tsx`),
 * so the four layers below stay framework-agnostic — the same overlay
 * stack would also work over a flat black bg.
 */

import { Box } from '@chakra-ui/react';

export function CrtOverlay(): React.ReactElement {
  return (
    <>
      {/* z=0 — coarse grid */}
      <Box
        position="absolute"
        inset="0"
        pointerEvents="none"
        zIndex={0}
        opacity={0.22}
        backgroundImage="linear-gradient(rgb(26, 58, 38) 1px, transparent 1px), linear-gradient(90deg, rgb(26, 58, 38) 1px, transparent 1px)"
        backgroundSize="32px 32px"
      />
      {/* z=1 — phosphor dot mesh */}
      <Box
        position="absolute"
        inset="0"
        pointerEvents="none"
        zIndex={1}
        opacity={0.4}
        backgroundImage="radial-gradient(rgba(155, 242, 182, 0.06) 1px, transparent 1px)"
        backgroundSize="3px 3px"
      />
      {/* z=4 — horizontal scanlines */}
      <Box
        position="absolute"
        inset="0"
        pointerEvents="none"
        zIndex={4}
        background="repeating-linear-gradient(0deg, rgba(0, 0, 0, 0.32) 0px, rgba(0, 0, 0, 0.32) 1px, transparent 1px, transparent 3px)"
        css={{ mixBlendMode: 'multiply' }}
      />
      {/* z=6 — vignette + soft inner glow */}
      <Box
        position="absolute"
        inset="0"
        pointerEvents="none"
        zIndex={6}
        boxShadow="rgba(0, 0, 0, 0.92) 0px 0px 220px inset, rgba(0, 80, 40, 0.3) 0px 0px 90px inset"
        borderRadius="12px"
      />
    </>
  );
}
