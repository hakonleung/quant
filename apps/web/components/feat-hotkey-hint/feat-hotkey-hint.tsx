'use client';

/**
 * `FeatHotkeyHint` — floating window listing the keystrokes available
 * under the current scope. Opens on `?` (global cell `ui.hint-toggle`),
 * dismisses on `Esc` (engine priority chain).
 *
 * - Minimizable to a corner badge that announces the count of available
 *   keys + the `?` reopen hint.
 * - Renders with `role="dialog" aria-modal="false"` (it does not trap
 *   focus — users continue typing other keys to dispatch).
 * - Subscribes to the focus store + queries `uiRegistry.visible(ctx)`
 *   so the list updates on Feat change.
 */

import { Box, Flex, Text } from '@chakra-ui/react';
import { useMemo } from 'react';

import { Feat } from '../../lib/eqty/feat.js';
import type { CmdGroup, UiBinding, UiCtx } from '../../lib/ui-cmd/index.js';
import { uiRegistry, useActiveScope, useFocusStore } from '../../lib/ui-cmd/index.js';

const GROUP_ORDER: readonly CmdGroup[] = ['nav', 'view', 'action', 'edit'];
const GROUP_LABEL: Readonly<Record<CmdGroup, string>> = {
  nav: 'Navigate',
  view: 'View',
  action: 'Actions',
  edit: 'Edit',
};

export function FeatHotkeyHint(): React.ReactElement | null {
  const ctx = useActiveScope();
  const hintOpen = useFocusStore((s) => s.hintOpen);
  const hintMinimized = useFocusStore((s) => s.hintMinimized);
  const setHintMinimized = useFocusStore((s) => s.setHintMinimized);
  const toggleHintOpen = useFocusStore((s) => s.toggleHintOpen);

  const visible = useMemo<readonly UiBinding[]>(
    () => (hintOpen ? uiRegistry.visible(ctx).filter((b) => b.seq.length > 0) : []),
    [hintOpen, ctx],
  );
  const grouped = useMemo(() => groupBindings(visible), [visible]);

  if (!hintOpen) return null;
  if (hintMinimized) {
    return (
      <Box
        as="button"
        role="button"
        position="fixed"
        right="16px"
        bottom="16px"
        zIndex={9999}
        bg="rgba(10,14,16,0.92)"
        color="accent"
        borderWidth="1px"
        borderColor="line2"
        borderRadius="4px"
        px="10px"
        py="6px"
        fontFamily="mono"
        fontSize="11px"
        letterSpacing="0.1em"
        cursor="pointer"
        aria-label={`open keyboard hint (${visible.length} shortcuts)`}
        _focusVisible={{
          outline: '2px solid',
          outlineColor: 'accent',
          outlineOffset: '2px',
        }}
        onClick={() => setHintMinimized(false)}
      >
        ? {visible.length}
      </Box>
    );
  }

  return (
    <Box
      role="dialog"
      aria-modal={false}
      aria-label={`keyboard shortcuts${ctx.activeFeat !== null ? ` for ${ctx.activeFeat}` : ''}`}
      position="fixed"
      right="16px"
      bottom="16px"
      maxW="360px"
      maxH="60vh"
      overflowY="auto"
      zIndex={9999}
      bg="rgba(8,11,13,0.96)"
      color="ink"
      borderWidth="1px"
      borderColor="line2"
      borderRadius="4px"
      boxShadow="0 6px 22px rgba(0,0,0,0.45)"
      fontFamily="mono"
      fontSize="11px"
    >
      <Flex
        align="center"
        justify="space-between"
        px="10px"
        py="6px"
        borderBottomWidth="1px"
        borderColor="line2"
        bg="rgba(20,28,32,0.85)"
      >
        <Text fontWeight="700" letterSpacing="0.14em" color="accent">
          KEYS · {ctx.activeFeat ?? 'global'}
        </Text>
        <Flex gap="4px">
          <HeaderButton label="minimize hint" onClick={() => setHintMinimized(true)}>
            _
          </HeaderButton>
          <HeaderButton label="close hint" onClick={toggleHintOpen}>
            ×
          </HeaderButton>
        </Flex>
      </Flex>
      <Box px="10px" py="8px">
        {grouped.length === 0 ? (
          <Text color="ink2">No shortcuts available in this scope.</Text>
        ) : (
          grouped.map(([group, list]) => (
            <Box key={group} mb="8px">
              <Text
                color="ink2"
                fontSize="9px"
                letterSpacing="0.18em"
                mb="3px"
              >
                {GROUP_LABEL[group]}
              </Text>
              {list.map((b) => (
                <Flex
                  key={`${b.cellId}::${b.seq.join(' ')}`}
                  align="baseline"
                  gap="10px"
                  py="2px"
                >
                  <Text minW="64px" color="accent" fontWeight="700">
                    {b.seq.join(' ') || '—'}
                  </Text>
                  <Text color="ink">{b.ui.label}</Text>
                </Flex>
              ))}
            </Box>
          ))
        )}
        <Text mt="6px" color="ink2" fontSize="9px" letterSpacing="0.12em">
          ? toggle · Esc close · z f fullscreen · z m minimize
        </Text>
      </Box>
    </Box>
  );
}

interface HeaderButtonProps {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}

function HeaderButton({ label, onClick, children }: HeaderButtonProps): React.ReactElement {
  return (
    <Box
      as="button"
      role="button"
      aria-label={label}
      onClick={onClick}
      w="20px"
      h="20px"
      display="grid"
      placeItems="center"
      bg="transparent"
      color="ink2"
      borderWidth="1px"
      borderColor="line2"
      borderRadius="2px"
      cursor="pointer"
      _hover={{ color: 'accent', borderColor: 'accent' }}
      _focusVisible={{
        outline: '2px solid',
        outlineColor: 'accent',
        outlineOffset: '1px',
      }}
    >
      {children}
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
  return GROUP_ORDER.filter((g) => buckets[g].length > 0).map(
    (g) => [g, buckets[g]] as const,
  );
}

// Quiet TS unused-import when build-time tree-shakes.
void Feat;
void (null as UiCtx | null);
