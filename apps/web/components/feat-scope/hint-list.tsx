'use client';

/**
 * Renders the active-scope keymap as a grouped list. Used inside the
 * SCOPE pane body (replaces the standalone `<FeatHotkeyHint/>` floating
 * dialog — the user wanted the hint content surfaced through SCOPE's
 * own expand/collapse rather than as a parallel window).
 *
 * Pure-ish presenter: subscribes to the focus store + queries
 * `uiRegistry.visible(ctx)` so the list updates on Feat change, but
 * owns no UI state of its own (the SCOPE pane drives min/normal).
 */

import { Box, Flex, Text } from '@chakra-ui/react';
import { useMemo } from 'react';

import type { CmdGroup, UiBinding } from '../../lib/ui-cmd/index.js';
import { uiRegistry, useActiveScope } from '../../lib/ui-cmd/index.js';

const GROUP_ORDER: readonly CmdGroup[] = ['nav', 'view', 'action', 'edit'];
const GROUP_LABEL: Readonly<Record<CmdGroup, string>> = {
  nav: 'Navigate',
  view: 'View',
  action: 'Actions',
  edit: 'Edit',
};

export function HintList(): React.ReactElement {
  const ctx = useActiveScope();
  const visible = useMemo<readonly UiBinding[]>(
    () => uiRegistry.visible(ctx).filter((b) => b.seq.length > 0),
    [ctx],
  );
  const grouped = useMemo(() => groupBindings(visible), [visible]);

  return (
    <Box
      px="10px"
      py="8px"
      fontFamily="mono"
      fontSize="xs"
      color="term.ink"
      maxH="50vh"
      overflowY="auto"
    >
      {grouped.length === 0 ? (
        <Text color="term.ink2">No shortcuts available in this scope.</Text>
      ) : (
        grouped.map(([group, list]) => (
          <Box key={group} mb="8px">
            <Text color="term.ink2" fontSize="xs" letterSpacing="0.18em" mb="3px">
              {GROUP_LABEL[group]}
            </Text>
            {list.map((b) => (
              <Flex key={`${b.cellId}::${b.seq.join(' ')}`} align="baseline" gap="10px" py="2px">
                <Text minW="64px" color="accent" fontWeight="700">
                  {b.seq.join(' ') || '—'}
                </Text>
                <Text color="term.ink">{b.ui.label}</Text>
              </Flex>
            ))}
          </Box>
        ))
      )}
      <Text mt="6px" color="term.ink3" fontSize="xs" letterSpacing="0.12em">
        ? toggle · z f fullscreen · z m minimize
      </Text>
    </Box>
  );
}

function groupBindings(
  bindings: readonly UiBinding[],
): ReadonlyArray<readonly [CmdGroup, readonly UiBinding[]]> {
  const buckets: Record<CmdGroup, UiBinding[]> = {
    nav: [],
    view: [],
    action: [],
    edit: [],
  };
  for (const b of bindings) {
    if (b.seq.length === 0) continue; // mouse-only — not a keyboard hint
    buckets[b.ui.group].push(b);
  }
  for (const g of GROUP_ORDER) {
    buckets[g].sort((a, b) => a.seq.join(' ').localeCompare(b.seq.join(' ')));
  }
  return GROUP_ORDER.filter((g) => buckets[g].length > 0).map((g) => [g, buckets[g]] as const);
}
