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
import { useTokenColor } from '../../lib/theme/use-token-color.js';

import { FeatDev } from '../feat-dev/feat-dev.js';
import { FeatLedger } from '../feat-ledger/feat-ledger.js';
import { FeatScope } from '../feat-scope/feat-scope.js';
import { FeatSettings } from '../feat-settings/feat-settings.js';
import { FeatSysMain } from '../feat-sys-main/feat-sys-main.js';
import { FeatWatchLive } from '../feat-watch-live/feat-watch-live.js';

import type { SessionChipInfo } from './app-shell.js';
import { LogoArt } from './logo-art.js';

const BRAND_HEIGHT = 52;
const BRAND_HEIGHT_MOBILE = 44;

interface TopBarProps {
  readonly session?: SessionChipInfo | undefined;
}

export function TopBar({ session }: TopBarProps = {}): React.ReactElement {
  const { mode } = useViewport();
  const isMobile = mode === 'mobile';
  return (
    <Flex
      minH={`${String(isMobile ? BRAND_HEIGHT_MOBILE : BRAND_HEIGHT)}px`}
      // Transparent TopBar — the body wallpaper (logo bg recipe)
      // shows through directly, so the Brand visually integrates with
      // the canvas (no border, no glass strip separating them). Each
      // pane self-margins (4 px) so the topbar doesn't compose gaps.
      //
      // `flex-start` cross-axis: bodyOverlay panes are header-only
      // tiles. With `stretch` they grew to the topbar's 52 px and
      // showed an empty strip below the header. `flex-start` lets
      // each pane size to its actual content (just the header).
      bg="transparent"
      align="flex-start"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      <Brand compact={isMobile} stretch={isMobile} />
      {/* Topbar tiles — collapsed to the bottom-tab nav on mobile. SYS
       * stretches to absorb leftover row width; SET / LDG / WATCH are
       * fixed-shaped chip-style panes whose bodies float as overlays
       * when restored (bodyOverlay config). */}
      {!isMobile && (
        <>
          <Box flex="1" minW={0} display="flex">
            <FeatSysMain />
          </Box>
          <Box display="flex">
            <FeatScope />
          </Box>
          <Box display="flex">
            <FeatDev />
          </Box>
          <Box display="flex">
            <FeatLedger />
          </Box>
          <Box display="flex">
            <FeatWatchLive />
          </Box>
          <Box display="flex">
            <FeatSettings session={session} />
          </Box>
        </>
      )}
    </Flex>
  );
}

interface BrandProps {
  readonly compact?: boolean;
  /** Fill the available row width — used on mobile where SYS / USR move
   *  to the bottom nav and the topbar collapses to just the brand. */
  readonly stretch?: boolean;
}

function Brand({ compact = false, stretch = false }: BrandProps): React.ReactElement {
  const setAppMode = useLayoutStore((s) => s.setAppMode);
  // brand.logoBg / gridColor / scanlineAlpha are owned by `<PageBackdrop>`
  // now — the brand button just floats on top of the page wallpaper.
  const termLogoColor = useTokenColor('brand.logoColor');
  const termLogoGlow = useTokenColor('brand.logoGlow');
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
      flex={stretch ? '1' : undefined}
      justifyContent={stretch ? 'flex-start' : undefined}
      flexShrink={0}
      cursor="pointer"
      border="0"
      overflow="hidden"
      // No own bg — body wallpaper IS the logo bg recipe, so the
      // brand text floats on the canvas with zero seam.
      style={{ viewTransitionName: 'app-logo' }}
      _hover={{ filter: 'brightness(1.15)' }}
      // Solid 2-px Apple-blue ring (≥3:1 contrast on every CRT bg)
      // replaces the old translucent inset ring that washed out
      // against the brand backdrop. `outlineOffset:-2px` keeps the
      // ring inside the button so it doesn't bleed into the topbar.
      _focusVisible={{ outline: '2px solid', outlineColor: 'link', outlineOffset: '-2px' }}
    >
      <Box position="relative" zIndex={2}>
        <LogoArt
          color={termLogoColor}
          fontSize={compact ? '6px' : '7.5px'}
          lineHeight="1"
          letterSpacing={compact ? '0.5px' : '1px'}
          textShadow={termLogoGlow}
          showCursor={false}
        />
      </Box>
    </Box>
  );
}

