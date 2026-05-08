'use client';

/**
 * Top bar — brand mark + SYS.STAT (live capsules) + SYS.CFG (settings).
 *
 * SYS.STAT used to live at the bottom of the page; mounting it here
 * keeps the live WS / queue / mem / fps capsules in the user's eye
 * line at all times.
 *
 * SYS.CFG is the catch-all for persisted UI settings — blacklist and
 * the EQ.LIST column manager. It replaces the SEC.BLACK side-pane and
 * the ⚙ gear that used to sit on the EQ.LIST header.
 *
 * The cross-market search input (M-0 / SCR.NL) has been removed from
 * the top-bar; picking now happens from inside individual panes.
 *
 * The Brand cell uses the same dark CRT background + scanline overlay
 * as TERM.MAIN's BigLogo so the workbench and terminal modes read as
 * the same OS chrome. Click to toggle into term mode.
 */

import { Box, Flex } from '@chakra-ui/react';

import { runViewTransition } from '../../lib/fp/view-transition.js';
import { useViewport } from '../../lib/hooks/use-viewport.js';
import { useLayoutStore } from '../../lib/stores/layout.store.js';

import { FeatChannelLive } from '../feat-channel/feat-channel.js';
import { FeatSysCfg } from '../feat-sys-cfg/feat-sys-cfg.js';
import { FeatSysStat } from '../feat-sys-stat/feat-sys-stat.js';

import type { SessionChipInfo } from './app-shell.js';
import { LogoArt } from './logo-art.js';
import { UserChip } from './user-chip.js';

const BRAND_HEIGHT = 52;
const BRAND_HEIGHT_MOBILE = 44;
const TERM_BG = 'radial-gradient(ellipse at center, #08120c 0%, #04060a 65%, #020406 100%)';
const TERM_LOGO_COLOR = '#d4ffe2';
const TERM_LOGO_GLOW =
  'rgba(155, 242, 182, 0.8) 0px 0px 4px, rgba(155, 242, 182, 0.4) 0px 0px 12px';

interface TopBarProps {
  readonly session?: SessionChipInfo | undefined;
}

export function TopBar({ session }: TopBarProps = {}): React.ReactElement {
  const { mode } = useViewport();
  const isMobile = mode === 'mobile';
  // SYS.STAT capsule strip (queue / mem / fps) eats ~360px even
  // collapsed; on mobile it pushes Channel/SysCfg off-screen, so we
  // drop it from the topbar — the user can still get queue progress
  // from the in-pane status badges. Channel + SysCfg shrink to icon-
  // sized chips since their bodies are bodyOverlay anchored to the
  // header rect, the inline width only affects the chip click target.
  const sideSlot = isMobile ? '96px' : '220px';
  return (
    <Flex
      minH={`${String(isMobile ? BRAND_HEIGHT_MOBILE : BRAND_HEIGHT)}px`}
      bg="panel"
      borderBottomWidth="2px"
      borderBottomColor="accent"
      align="stretch"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      <Brand compact={isMobile} />
      {!isMobile && (
        <Box flex="1" minW={0} display="flex" alignItems="stretch">
          <FeatSysStat />
        </Box>
      )}
      {isMobile && <Box flex="1" minW={0} />}
      <Box w={sideSlot} flex="0 0 auto" display="flex" alignItems="stretch">
        <FeatChannelLive />
      </Box>
      <Box w={sideSlot} flex="0 0 auto" display="flex" alignItems="stretch">
        <FeatSysCfg />
      </Box>
      {session !== undefined && (
        <Box flex="0 0 auto" display="flex" alignItems="stretch">
          <UserChip displayName={session.displayName} mode={session.mode} />
        </Box>
      )}
    </Flex>
  );
}

interface BrandProps {
  readonly compact?: boolean;
}

function Brand({ compact = false }: BrandProps): React.ReactElement {
  const setAppMode = useLayoutStore((s) => s.setAppMode);
  const onToggle = (): void => {
    runViewTransition(typeof document === 'undefined' ? null : document, () => {
      setAppMode('term');
    });
  };
  // ASCII pixel-art logo on a CRT background. The cursor block is
  // term-only — the regular-mode brand stays static so the eye doesn't
  // track an animating glyph in the chrome.
  return (
    <Box
      as="button"
      onClick={onToggle}
      title="enter TERM mode"
      aria-label="Enter terminal mode"
      position="relative"
      h="100%"
      pl={compact ? '10px' : '16px'}
      pr={compact ? '12px' : '20px'}
      display="flex"
      alignItems="center"
      flexShrink={0}
      cursor="pointer"
      border="0"
      overflow="hidden"
      style={{ background: TERM_BG, viewTransitionName: 'app-logo' }}
      _hover={{ filter: 'brightness(1.15)' }}
      _focus={{ outline: 'none', boxShadow: '0 0 0 2px rgba(155,242,182,0.4) inset' }}
    >
      <CrtBackdrop />
      <Box position="relative" zIndex={2}>
        <LogoArt
          color={TERM_LOGO_COLOR}
          fontSize={compact ? '6px' : '7.5px'}
          lineHeight="1"
          letterSpacing={compact ? '0.5px' : '1px'}
          textShadow={TERM_LOGO_GLOW}
          showCursor={false}
        />
      </Box>
    </Box>
  );
}

/**
 * CRT chrome — coarse grid (z=0) + horizontal scanlines (z=1).
 * Extracted from Brand so the latter stays under the per-function
 * line cap; the layers never change at runtime.
 */
function CrtBackdrop(): React.ReactElement {
  return (
    <>
      <Box
        position="absolute"
        inset="0"
        pointerEvents="none"
        zIndex={0}
        opacity={0.32}
        backgroundImage="linear-gradient(rgb(26, 58, 38) 1px, transparent 1px), linear-gradient(90deg, rgb(26, 58, 38) 1px, transparent 1px)"
        backgroundSize="16px 16px"
      />
      <Box
        position="absolute"
        inset="0"
        pointerEvents="none"
        zIndex={1}
        background="repeating-linear-gradient(0deg, rgba(0, 0, 0, 0.32) 0px, rgba(0, 0, 0, 0.32) 1px, transparent 1px, transparent 3px)"
        css={{ mixBlendMode: 'multiply' }}
      />
    </>
  );
}
