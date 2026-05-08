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
import { useLayoutStore } from '../../lib/stores/layout.store.js';
import { LogoArt } from '../shell/logo-art.js';

const LOGO_COLOR = '#d4ffe2';
const LOGO_GLOW =
  'rgba(155, 242, 182, 0.8) 0px 0px 4px, rgba(155, 242, 182, 0.4) 0px 0px 12px, rgba(155, 242, 182, 0.2) 0px 0px 28px';

export function BigLogo(): React.ReactElement {
  const setAppMode = useLayoutStore((s) => s.setAppMode);
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
      position="relative"
      bg="transparent"
      border="0"
      p={0}
      cursor="pointer"
      style={{ viewTransitionName: 'app-logo' }}
    >
      <LogoArt color={LOGO_COLOR} fontSize="11.05px" textShadow={LOGO_GLOW} />
    </Box>
  );
}
