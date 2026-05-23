'use client';

/**
 * `ScopeBadge` — small persistent indicator showing the currently-active
 * Feat. Sits in the bottom-right next to the hint window so users can
 * tell which keymap is live without invoking `?`.
 *
 * Click opens the full hint (same effect as `?`). Hidden when the hint
 * dialog is already visible to avoid duplicate chrome.
 */

import { Box, Text } from '@chakra-ui/react';

import { useFocusStore } from '../../lib/ui-cmd/store/focus.js';

const RIGHT_OFFSET = '16px';
const BOTTOM_OFFSET_HIDDEN = '16px';
// When the hint badge (minimized hint) is showing, slide left a bit so
// the two pills don't overlap.
const RIGHT_OFFSET_WITH_BADGE = '88px';

export function ScopeBadge(): React.ReactElement | null {
  const activeFeat = useFocusStore((s) => s.activeFeat);
  const hintOpen = useFocusStore((s) => s.hintOpen);
  const hintMinimized = useFocusStore((s) => s.hintMinimized);
  const openHint = useFocusStore((s) => s.toggleHintOpen);

  // Don't double up on chrome while the full dialog is showing.
  if (hintOpen && !hintMinimized) return null;

  const label = activeFeat ?? '—';
  const showsBadgeNeighbour = hintOpen && hintMinimized;

  return (
    <Box
      as="button"
      aria-label={`active scope ${label}; press ? for shortcuts`}
      position="fixed"
      right={showsBadgeNeighbour ? RIGHT_OFFSET_WITH_BADGE : RIGHT_OFFSET}
      bottom={BOTTOM_OFFSET_HIDDEN}
      zIndex={9998}
      bg="rgba(10,14,16,0.78)"
      color="ink2"
      borderWidth="1px"
      borderColor="line2"
      borderRadius="4px"
      px="8px"
      py="4px"
      fontFamily="mono"
      fontSize="10px"
      letterSpacing="0.16em"
      cursor="pointer"
      _hover={{ color: 'accent', borderColor: 'accent' }}
      _focusVisible={{
        outline: '2px solid',
        outlineColor: 'accent',
        outlineOffset: '2px',
      }}
      onClick={openHint}
    >
      <Text as="span" color="ink3">
        scope
      </Text>{' '}
      <Text as="span" color="accent" fontWeight="700">
        {label}
      </Text>{' '}
      <Text as="span" color="ink3" fontSize="9px">
        ?
      </Text>
    </Box>
  );
}
