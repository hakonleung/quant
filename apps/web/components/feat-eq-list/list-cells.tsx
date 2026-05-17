'use client';

/**
 * Leaf cell renderers for EQ.LIST rows. Each cell is a pure
 * presentational component — pulls a single value (or pair) and
 * returns a `<Text>` styled per the workbench's mono-chrome palette.
 *
 * Split out of `feat-eq-list.tsx` so the orchestrator file can stay
 * under the 400-line ceiling and so cells are individually
 * importable from the few other panes that show a price / pct
 * column (LDG, WATCH).
 */

import { Text } from '@chakra-ui/react';

interface PriceCellProps {
  readonly pct: number | null;
  readonly price: number | null;
}

export function PriceCell({ pct, price }: PriceCellProps): React.ReactElement {
  if (price === null) {
    return (
      <Text fontFamily="mono" fontSize="11px" color="ink3">
        —
      </Text>
    );
  }
  const color = pct === null ? 'ink3' : pct > 0 ? 'up' : pct < 0 ? 'down' : 'ink3';
  return (
    <Text fontFamily="mono" fontSize="11px" color={color} fontWeight="600">
      {price.toFixed(2)}
    </Text>
  );
}

interface ValueCellProps {
  readonly value: number | null;
}

export function ChgPctCell({ value }: ValueCellProps): React.ReactElement {
  if (value === null) {
    return (
      <Text fontFamily="mono" fontSize="11px" color="ink3">
        —
      </Text>
    );
  }
  const pct = value * 100;
  const color = pct > 0 ? 'up' : pct < 0 ? 'down' : 'ink3';
  const sign = pct > 0 ? '+' : '';
  return (
    <Text fontFamily="mono" fontSize="11px" color={color} fontWeight="600">
      {sign}
      {pct.toFixed(2)}%
    </Text>
  );
}

export function PctCell({ value }: ValueCellProps): React.ReactElement {
  return (
    <Text fontFamily="mono" fontSize="11px" color={value === null ? 'ink3' : 'ink2'}>
      {value === null ? '—' : `${(value * 100).toFixed(2)}%`}
    </Text>
  );
}

export function CnyCell({ value }: ValueCellProps): React.ReactElement {
  if (value === null) {
    return (
      <Text fontFamily="mono" fontSize="11px" color="ink3">
        —
      </Text>
    );
  }
  const yi = 1e8;
  const wan = 1e4;
  const text =
    value >= yi
      ? `${(value / yi).toFixed(2)}亿`
      : value >= wan
        ? `${(value / wan).toFixed(0)}万`
        : value.toFixed(0);
  return (
    <Text fontFamily="mono" fontSize="11px" color="ink2">
      {text}
    </Text>
  );
}

/**
 * Signed CNY cell — magnitudes use the same `亿` / `万` collapse as
 * {@link CnyCell}, but the sign is preserved and colour-coded
 * (`+流入` green / `-流出` red). Used for DDE 主力净流入 cells.
 */
export function CnyDeltaCell({ value }: ValueCellProps): React.ReactElement {
  if (value === null) {
    return (
      <Text fontFamily="mono" fontSize="11px" color="ink3">
        —
      </Text>
    );
  }
  const yi = 1e8;
  const wan = 1e4;
  const abs = Math.abs(value);
  const body =
    abs >= yi ? `${(abs / yi).toFixed(2)}亿` : abs >= wan ? `${(abs / wan).toFixed(0)}万` : abs.toFixed(0);
  const color = value > 0 ? 'up' : value < 0 ? 'down' : 'ink3';
  const sign = value >= 0 ? '+' : '-';
  return (
    <Text fontFamily="mono" fontSize="11px" color={color} fontWeight="600">
      {sign}
      {body}
    </Text>
  );
}
