'use client';

/**
 * TERM.MAIN big "qX//OS_" ASCII pixel-art logo, with green-CRT glow.
 *
 * The ASCII grid is shared with the TopBar's small Brand variant via
 * the `LogoArt` primitive in `components/shell/logo-art.tsx`. This
 * file owns only the term-mode chrome — the click-to-exit affordance
 * + the CRT styling (color, glow, scale).
 */

import { Box } from '@chakra-ui/react';

import { runViewTransition } from '../../lib/fp/view-transition.js';
import { useViewport } from '../../lib/hooks/use-viewport.js';
import { useLayoutStore } from '../../lib/stores/layout.store.js';
import { useTokenColor } from '../../lib/theme/use-token-color.js';
import { LogoArt } from '../shell/logo-art.js';

export function BigLogo(): React.ReactElement {
  const setAppMode = useLayoutStore((s) => s.setAppMode);
  const logoColor = useTokenColor('brand.logoColor');
  const logoGlow = useTokenColor('brand.logoGlow');
  // The ASCII grid is 46 chars wide. At 11.05 px + 1 px letter-spacing
  // it renders ≈ 350 px — fits desktop but eats the entire row on a
  // 375 px phone, leaving header sys-stat with no breathing room. Drop
  // to 6.5 px on mobile (≈ 215 px) so the brand stays prominent without
  // overflowing.
  const { mode: vpMode } = useViewport();
  const fontSize = vpMode === 'mobile' ? '6.5px' : '11.05px';
  const letterSpacing = vpMode === 'mobile' ? '0.5px' : '1px';
  const onClick = (): void => {
    runViewTransition(typeof document === 'undefined' ? null : document, () => {
      setAppMode('regular');
    });
  };
  return (
    <Box
      as="button"
      onClick={onClick}
      title="exit TERM mode"
      aria-label="Exit terminal mode"
      position="relative"
      bg="transparent"
      border="0"
      p={0}
      cursor="pointer"
      style={{ viewTransitionName: 'app-logo' }}
    >
      <LogoArt
        color={logoColor}
        fontSize={fontSize}
        letterSpacing={letterSpacing}
        textShadow={logoGlow}
      />
    </Box>
  );
}
