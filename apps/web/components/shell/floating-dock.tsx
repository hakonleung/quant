'use client';

/**
 * Bottom-right dock for floating panes.
 *
 * Hosts every `config.floating === true` pane in a single fixed
 * container so the corner stays tidy regardless of how many overlays
 * are mounted. Stack order is `column-reverse` so the youngest pane
 * sits at the BOTTOM of the visible stack (next to the corner) and
 * earlier ones grow upward — matches the existing FeatHotkeyHint
 * placement at the very corner and keeps the most-frequently-glanced
 * floating panes (DEV / SCOPE) inside the user's eye line.
 *
 * z-index `scopeBadge` matches the legacy ScopeBadge token so any
 * stacking-context expectations elsewhere keep working.
 */

import { Box } from '@chakra-ui/react';

import { FeatDev } from '../feat-dev/feat-dev.js';
import { FeatScope } from '../feat-scope/feat-scope.js';

export function FloatingDock(): React.ReactElement {
  return (
    <Box
      position="fixed"
      // Pinned to the very bottom-right of the viewport — the spec
      // wants the dock flush with the corner so it reads as a single
      // chrome cluster. Safe-area padding pushes it back inboard on
      // iOS so the home indicator doesn't overlap the SCOPE pill.
      right={0}
      bottom={0}
      zIndex="scopeBadge"
      display="flex"
      flexDirection="column-reverse"
      alignItems="flex-end"
      gap="4px"
      pointerEvents="none"
      style={{
        paddingRight: 'env(safe-area-inset-right)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
      // Each child pane re-enables pointer events on itself; the
      // wrapper stays transparent to clicks so the workbench beneath
      // the dock is still reachable in the gaps between pills.
      css={{ '& > *': { pointerEvents: 'auto' } }}
    >
      <FeatScope />
      <FeatDev />
    </Box>
  );
}
