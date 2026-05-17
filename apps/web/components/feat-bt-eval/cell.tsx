'use client';

/** Shared right-aligned numeric / percent / "—" cell for the BT.EVAL tables. */

import { Box } from '@chakra-ui/react';

export interface CellProps {
  readonly num: number;
  readonly pct?: boolean;
  readonly digits?: number;
}

export function Cell({ num, pct, digits }: CellProps): React.ReactElement {
  const text = formatCell(num, pct, digits);
  const color = colorFor(num, pct);
  return (
    <Box as="td" px="6px" py="3px" textAlign="right" color={color}>
      {text}
    </Box>
  );
}

function formatCell(num: number, pct: boolean | undefined, digits: number | undefined): string {
  if (Number.isNaN(num)) return '—';
  if (pct === true) return `${(num * 100).toFixed(1)}%`;
  return num.toFixed(digits ?? 2);
}

function colorFor(num: number, pct: boolean | undefined): 'up' | 'down' | 'ink' {
  if (pct !== true || Number.isNaN(num) || num === 0) return 'ink';
  return num > 0 ? 'up' : 'down';
}
