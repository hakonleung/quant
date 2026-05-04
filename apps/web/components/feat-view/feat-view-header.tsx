'use client';

/**
 * Shared header-right primitives used by every FeatView:
 *
 *   <FeatViewStatus tone="green" /> · <FeatViewAction onClick title>⟳</FeatViewAction>
 *
 * `FeatViewStatus` renders only the colored bullet — no text label —
 * because the status word ("ready", "idle", "cached") is redundant
 * with the bullet color and clutters the 30px header.
 *
 * `FeatViewAction` is the single icon-button shape. The icon glyph is
 * scaled up so it stays legible inside the cyber pane chrome.
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

export function FeatViewStatus({ tone, blink = false }: FeatViewStatusProps): React.ReactElement {
  return (
    <Box
      as="span"
      className={blink ? 'blink' : undefined}
      color={TONE_TO_COLOR[tone]}
      fontFamily="mono"
      fontSize="14px"
      lineHeight="1"
      fontWeight="700"
    >
      {TONE_TO_GLYPH[tone]}
    </Box>
  );
}

interface FeatViewActionProps {
  readonly title: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly tone?: 'default' | 'accent' | 'danger';
  readonly children: ReactNode;
}

export function FeatViewAction({
  title,
  onClick,
  disabled = false,
  busy = false,
  tone = 'default',
  children,
}: FeatViewActionProps): React.ReactElement {
  const color =
    tone === 'accent' ? 'accent' : tone === 'danger' ? 'term.red' : 'term.ink2';
  const hoverColor =
    tone === 'accent' ? 'accentDark' : tone === 'danger' ? 'term.red' : 'term.green';
  const isDisabled = disabled || busy;
  return (
    <Box
      as="button"
      title={title}
      aria-label={title}
      aria-disabled={isDisabled}
      onClick={isDisabled ? undefined : onClick}
      w="22px"
      h="22px"
      display="grid"
      placeItems="center"
      bg="transparent"
      borderWidth="1px"
      borderColor={tone === 'accent' ? 'accent' : 'term.line'}
      borderRadius="0"
      cursor={isDisabled ? 'not-allowed' : 'pointer'}
      opacity={isDisabled ? 0.4 : 1}
      color={color}
      fontFamily="mono"
      fontSize="14px"
      fontWeight="700"
      lineHeight="1"
      _hover={isDisabled ? {} : { color: hoverColor, borderColor: hoverColor }}
    >
      {busy ? '…' : children}
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
