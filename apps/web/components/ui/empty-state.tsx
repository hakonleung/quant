'use client';

/**
 * Standard empty / blocked-state surface — a single visual idiom for
 * panes that have no data yet, no permission to load, or are
 * waiting on an upstream prerequisite.
 *
 * Three slots:
 *   - `glyph`   — single-character mono glyph, optional. Defaults to
 *                 `//` so empty surfaces still feel like comments in
 *                 the workbench's "code-as-UI" idiom.
 *   - `title`   — one-line headline, mono, accent colour
 *   - `body`    — multi-line prose, ink2; pre-wraps so the caller can
 *                 newline-format reasoning
 *   - `action`  — slot for a button / link the user should hit next
 *
 * Lives in `apps/web/components/ui/` rather than `packages/ui/`
 * because every caller is the workbench itself — moving to the
 * shared package would force Chakra into a Chakra-free package
 * (CLAUDE.md §2.5.2 — abstraction follows the third user, not
 * before).
 */

import { Box, Flex, Text } from '@chakra-ui/react';
import type { ReactElement, ReactNode } from 'react';

interface EmptyStateProps {
  readonly glyph?: string;
  readonly title: string;
  readonly body?: ReactNode;
  readonly action?: ReactNode;
  /** When true, the surface paints with the cyber `term.*` palette
   *  (used by panes inside the TERM slot or sentiment results).
   *  Defaults to the regular workbench palette. */
  readonly cyber?: boolean;
}

export function EmptyState({
  glyph = '//',
  title,
  body,
  action,
  cyber = false,
}: EmptyStateProps): ReactElement {
  const inkBody = cyber ? 'term.ink2' : 'ink2';
  const inkAccent = cyber ? 'term.green' : 'accent';
  return (
    <Flex
      flex="1"
      align="center"
      justify="center"
      direction="column"
      gap="10px"
      px="24px"
      py="32px"
      role="status"
      textAlign="center"
    >
      <Text
        fontFamily="mono"
        fontSize="20px"
        color={inkAccent}
        letterSpacing="0.04em"
        aria-hidden="true"
      >
        {glyph}
      </Text>
      <Text
        fontFamily="mono"
        fontSize="13px"
        fontWeight="700"
        color={inkAccent}
        letterSpacing="0.06em"
      >
        {title}
      </Text>
      {body !== undefined && (
        <Box
          fontFamily="mono"
          fontSize="11px"
          color={inkBody}
          lineHeight="1.7"
          maxW="320px"
          whiteSpace="pre-wrap"
        >
          {body}
        </Box>
      )}
      {action !== undefined && <Box mt="6px">{action}</Box>}
    </Flex>
  );
}
