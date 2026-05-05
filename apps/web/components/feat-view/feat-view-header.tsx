'use client';

/**
 * Shared header-right primitives used by every FeatView. Status pellet
 * + action buttons live in this slot. `FeatViewStatus` only paints
 * abnormal tones — green / idle return `null` so the steady state
 * doesn't clutter the chrome. Pane-level actions are rendered through
 * `<MonoButton icon=... label=...>` directly.
 */

import { Box, Flex } from '@chakra-ui/react';
import type { ReactNode } from 'react';

export type FeatViewStatusTone = 'green' | 'amber' | 'red' | 'idle' | 'accent';

const TONE_TO_COLOR: Readonly<Record<FeatViewStatusTone, string>> = {
  green: 'term.green',
  amber: 'term.amber',
  red: 'term.red',
  idle: 'term.ink3',
  accent: 'accent',
};

const TONE_TO_GLYPH: Readonly<Record<FeatViewStatusTone, string>> = {
  green: '●',
  amber: '●',
  red: '✘',
  idle: '○',
  accent: '●',
};

interface FeatViewStatusProps {
  readonly tone: FeatViewStatusTone;
  readonly blink?: boolean;
}

export function FeatViewStatus({
  tone,
  blink = false,
}: FeatViewStatusProps): React.ReactElement | null {
  // Hide the dot for the "normal" steady state — a green pellet on every
  // pane is visual clutter. Surface only abnormal states (pending/warn/
  // error/special).
  if (tone === 'green' || tone === 'idle') return null;
  return (
    <Box
      as="span"
      className={blink ? 'blink' : undefined}
      color={TONE_TO_COLOR[tone]}
      fontFamily="mono"
      fontSize="10px"
      lineHeight="1"
      fontWeight="700"
    >
      {TONE_TO_GLYPH[tone]}
    </Box>
  );
}

interface FeatViewHeaderRightProps {
  readonly children: ReactNode;
}

/**
 * Standard horizontal layout for the right slot — status pellets first
 * (already paint in their order), then action buttons. Use it as the
 * direct value of `<FeatView right={...}>`.
 */
export function FeatViewHeaderRight({ children }: FeatViewHeaderRightProps): React.ReactElement {
  return (
    <Flex gap="6px" align="center">
      {children}
    </Flex>
  );
}
