'use client';

/**
 * SCOPE — floating pane showing the currently-active Feat.
 *
 * Replaces the standalone `<ScopeBadge/>` pill from 2026-05: the spec
 * asked for scope-wrapped-in-a-pane so chrome (hide/show via name
 * click) matches every other surface. The pane is `floating`, so
 * there's no fullscreen control and only two states (minimized /
 * normal) — clicking `SCOPE` in the header toggles them.
 *
 * The full keyboard-shortcut window (`<FeatHotkeyHint/>`) is still a
 * separate overlay reachable via `?`; SCOPE is intentionally
 * minimal — its only job is to tell the user which keymap is live.
 */

import { Box, Text } from '@chakra-ui/react';

import { Feat } from '../../lib/eqty/feat.js';
import { useFocusStore } from '../../lib/ui-cmd/store/focus.js';
import { FeatView } from '../feat-view/feat-view.js';

export function FeatScope(): React.ReactElement {
  const activeFeat = useFocusStore((s) => s.activeFeat);
  const label = activeFeat ?? '—';
  return (
    <FeatView
      feat={Feat.Scope}
      titleSlot={
        <Text
          fontFamily="mono"
          fontSize="xs"
          color="ink2"
          letterSpacing="0.16em"
          whiteSpace="nowrap"
        >
          {label}
        </Text>
      }
    >
      {/* Body is intentionally a single hint line — restoring the pane
          tells the user how to drill in further without crowding the
          dock. Full keymap stays in `?` (FeatHotkeyHint). */}
      <Box px="10px" py="6px" fontFamily="mono" fontSize="xs" color="ink3" letterSpacing="0.10em">
        active feat — press ? for the full keymap
      </Box>
    </FeatView>
  );
}
