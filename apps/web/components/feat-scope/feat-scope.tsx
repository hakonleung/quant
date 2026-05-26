'use client';

/**
 * SCOPE — floating pane showing the currently-active Feat plus the
 * keymap for that scope.
 *
 * Replaces the old standalone `<ScopeBadge/>` + `<FeatHotkeyHint/>`
 * pair from earlier 2026-05: the spec asked for scope-wrapped-in-a-
 * pane and for the SCOPE body to show "the original tips" (i.e. the
 * grouped key bindings the hint window used to surface). One pane
 * with min/normal toggle now does both jobs.
 *
 * The pane is `floating`, so there's no fullscreen control and only
 * two states — clicking `SCOPE` in the header toggles them. The `?`
 * global cell toggles the same mode via `setFeatViewMode`, so the
 * keyboard entry point still works.
 */

import { Text } from '@chakra-ui/react';

import { Feat } from '../../lib/eqty/feat.js';
import { useFocusStore } from '../../lib/ui-cmd/store/focus.js';
import { FeatView } from '../feat-view/feat-view.js';
import { HintList } from './hint-list.js';

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
      <HintList />
    </FeatView>
  );
}
