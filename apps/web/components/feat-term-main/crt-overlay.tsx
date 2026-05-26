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

import { useTokenColor } from '../../lib/theme/use-token-color.js';

export function CrtOverlay(): React.ReactElement {
  // Token reads so the overlay flips with the theme. In light mode the
  // grid colour shifts to a desaturated forest-grey, the phosphor dots
  // become a near-imperceptible darken (not green specks on white),
  // the scanline alpha drops to ~10% (avoids a striped-paper look on
  // the bright bg) and the vignette becomes a soft warm wash instead
  // of a black hole.
  const gridColor = useTokenColor('brand.gridColor');
  const phosphor = useTokenColor('brand.termGlowBorder');
  const scanlineAlpha = useTokenColor('brand.scanlineAlpha');
  const vignette = useTokenColor('brand.vignette');
  // Fallback only applies during SSR (useTokenColor returns ''). Pick
  // values consistent with the dialled-down glass-era tokens so the
  // server-rendered first paint doesn't flash a heavy CRT scanline.
  const scan = scanlineAlpha.length > 0 ? scanlineAlpha : 'rgba(0,0,0,0.10)';
  return (
    <>
      {/* z=0 — coarse grid (subtle glass texture, was the loud CRT mesh) */}
      <Box
        position="absolute"
        inset="0"
        pointerEvents="none"
        zIndex={0}
        opacity={0.22}
        backgroundImage={`linear-gradient(${gridColor} 1px, transparent 1px), linear-gradient(90deg, ${gridColor} 1px, transparent 1px)`}
        backgroundSize="32px 32px"
      />
      {/* z=1 — phosphor dot mesh (near-invisible, just a hint) */}
      <Box
        position="absolute"
        inset="0"
        pointerEvents="none"
        zIndex={1}
        opacity={0.4}
        backgroundImage={`radial-gradient(${phosphor} 1px, transparent 1px)`}
        backgroundSize="3px 3px"
      />
      {/* z=4 — horizontal scanlines (alpha already near-zero in token) */}
      <Box
        position="absolute"
        inset="0"
        pointerEvents="none"
        zIndex={4}
        background={`repeating-linear-gradient(0deg, ${scan} 0px, ${scan} 1px, transparent 1px, transparent 3px)`}
        css={{ mixBlendMode: 'multiply' }}
      />
      {/* z=6 — vignette becomes a soft ambient halo on the glass edge */}
      <Box
        position="absolute"
        inset="0"
        pointerEvents="none"
        zIndex={6}
        boxShadow={vignette}
        borderRadius="md"
      />
    </>
  );
}
