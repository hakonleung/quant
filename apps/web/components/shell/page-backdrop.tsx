'use client';

/**
 * `<PageBackdrop>` — fixed-position page-wide wallpaper layer rendered
 * **once** in `AppShell` (regular mode only). Pinned at `z-index: -1`
 * behind every interactive surface so glass panes / TopBar / Dialogs
 * all see the same canvas under them.
 *
 * Structure is a direct re-mount of the brand `CrtBackdrop` recipe
 * (`top-bar.tsx`) at viewport scale:
 *   - base `brand.logoBg` radial gradient (acts as the "wallpaper")
 *   - 16×16 px square grid hairlines (1 px at 4 % alpha, opacity 0.85)
 *   - 3-px horizontal scanline overlay (1 px at 1.5 % alpha,
 *     `mix-blend-mode: multiply` so the low-alpha line actually
 *     darkens the pixel underneath — additive composition at 1.5 %
 *     reads as invisible).
 *
 * Subscribes to `brand.*` tokens via `useTokenColor` so the texture
 * flips on theme change.
 */

import { Box } from '@chakra-ui/react';

import { useTokenColor } from '../../lib/theme/use-token-color.js';

export function PageBackdrop(): React.ReactElement {
  const logoBg = useTokenColor('brand.logoBg');
  const gridColor = useTokenColor('brand.gridColor');
  const scanlineAlpha = useTokenColor('brand.scanlineAlpha');
  // SSR fallbacks: read empty `useTokenColor` before hydration. Pick
  // values that mirror `palette.brand.light.*` so the first paint
  // matches the post-hydration look. Solid near-white now — the
  // radial gradient read as a gray vignette at viewport scale.
  const bg = logoBg.length > 0 ? logoBg : '#FAFAFC';
  const grid = gridColor.length > 0 ? gridColor : 'rgba(29,29,31,0.08)';
  const scan = scanlineAlpha.length > 0 ? scanlineAlpha : 'rgba(29,29,31,0.04)';
  return (
    <Box position="fixed" inset="0" pointerEvents="none" zIndex={0} background={bg}>
      <Box
        position="absolute"
        inset="0"
        pointerEvents="none"
        opacity={0.85}
        backgroundImage={`linear-gradient(${grid} 1px, transparent 1px), linear-gradient(90deg, ${grid} 1px, transparent 1px)`}
        backgroundSize="16px 16px"
      />
      <Box
        position="absolute"
        inset="0"
        pointerEvents="none"
        background={`repeating-linear-gradient(0deg, ${scan} 0px, ${scan} 1px, transparent 1px, transparent 3px)`}
        css={{ mixBlendMode: 'multiply' }}
      />
    </Box>
  );
}
