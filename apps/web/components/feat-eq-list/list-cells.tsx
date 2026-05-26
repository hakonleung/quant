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
      <Text fontFamily="mono" fontSize="xs" color="ink3">
        —
      </Text>
    );
  }
  const color = pct === null ? 'ink3' : pct > 0 ? 'up' : pct < 0 ? 'down' : 'ink3';
  return (
    <Text fontFamily="mono" fontSize="xs" color={color} fontWeight="600">
      {price.toFixed(2)}
    </Text>
  );
}

interface ValueCellProps {
  readonly value: number | null;
}

/** Signed score cell — generic helper kept for any future signed
 *  score column. WCMI no longer uses this since v2 the composite is
 *  always ≥ 0 (see {@link WcmiCell}). */
export function ScoreCell({ value }: ValueCellProps): React.ReactElement {
  if (value === null) {
    return (
      <Text fontFamily="mono" fontSize="xs" color="ink3">
        —
      </Text>
    );
  }
  const color = value > 0 ? 'up' : value < 0 ? 'down' : 'ink3';
  const sign = value > 0 ? '+' : '';
  return (
    <Text fontFamily="mono" fontSize="xs" color={color} fontWeight="600">
      {sign}
      {value.toFixed(0)}
    </Text>
  );
}

/** Sub-score percentile breakdown used by {@link WcmiCell}. Each value
 *  is the per-code cross-sectional percentile × 100 ∈ [0, 100], or
 *  `null` when the survivor gate fails. */
export interface WcmiSubScores {
  readonly rhythm: number | null;
  readonly maSupport: number | null;
  readonly upWave: number | null;
  readonly yangDom: number | null;
  readonly shadowClean: number | null;
  readonly stageGain: number | null;
  readonly crashAvoid: number | null;
  readonly recentStrength: number | null;
}

interface WcmiCellProps {
  readonly value: number | null;
  readonly sub: WcmiSubScores;
}

const WCMI_BIN_DIM = 300;
const WCMI_BIN_ACCENT = 700;

function wcmiBinColor(value: number): 'ink3' | 'ink2' | 'up' {
  if (value >= WCMI_BIN_ACCENT) return 'up';
  if (value < WCMI_BIN_DIM) return 'ink3';
  return 'ink2';
}

function formatSub(label: string, v: number | null): string {
  if (v === null) return `${label.padEnd(8)} —`;
  return `${label.padEnd(8)} ${v.toFixed(0)}`;
}

/**
 * WCMI composite cell. Output range after v2 redesign is `[0, 1000]`
 * (no longer signed), so the colour scale is single-direction:
 * `< 300` dim, `[300, 700)` normal, `≥ 700` accent. Hover shows the
 * seven sub-score percentiles via a native `title` tooltip — keeps
 * the row body free of extra DOM so the list stays virtualised
 * (CLAUDE.md §2.5 + memory `feedback_virtual_lists`).
 */
export function WcmiCell({ value, sub }: WcmiCellProps): React.ReactElement {
  if (value === null) {
    return (
      <Text fontFamily="mono" fontSize="xs" color="ink3">
        —
      </Text>
    );
  }
  const tooltip = [
    `WCMI ${value.toFixed(0)} (0–1000)`,
    formatSub('Rhythm', sub.rhythm),
    formatSub('MA Sup', sub.maSupport),
    formatSub('UpWave', sub.upWave),
    formatSub('YangDom', sub.yangDom),
    formatSub('ShdwCln', sub.shadowClean),
    formatSub('StgGain', sub.stageGain),
    formatSub('CrshAvd', sub.crashAvoid),
    formatSub('Recent', sub.recentStrength),
  ].join('\n');
  return (
    <Text
      as="span"
      title={tooltip}
      fontFamily="mono"
      fontSize="xs"
      color={wcmiBinColor(value)}
      fontWeight="600"
    >
      {value.toFixed(0)}
    </Text>
  );
}

/**
 * Single WCMI sub-score percentile cell. Value is in `[0, 100]`
 * (per-code cross-sectional percentile × 100 for one dimension).
 * Colour scale matches the composite {@link WcmiCell}: `< 30` dim,
 * `[30, 70)` normal, `≥ 70` accent — same bin boundaries scaled by
 * 10× (composite is 0–1000, sub-scores are 0–100).
 */
export function WcmiSubCell({ value }: ValueCellProps): React.ReactElement {
  if (value === null) {
    return (
      <Text fontFamily="mono" fontSize="xs" color="ink3">
        —
      </Text>
    );
  }
  const color = value >= 70 ? 'up' : value < 30 ? 'ink3' : 'ink2';
  return (
    <Text fontFamily="mono" fontSize="xs" color={color}>
      {value.toFixed(0)}
    </Text>
  );
}

export function ChgPctCell({ value }: ValueCellProps): React.ReactElement {
  if (value === null) {
    return (
      <Text fontFamily="mono" fontSize="xs" color="ink3">
        —
      </Text>
    );
  }
  const pct = value * 100;
  const color = pct > 0 ? 'up' : pct < 0 ? 'down' : 'ink3';
  const sign = pct > 0 ? '+' : '';
  return (
    <Text fontFamily="mono" fontSize="xs" color={color} fontWeight="600">
      {sign}
      {pct.toFixed(2)}%
    </Text>
  );
}

export function PctCell({ value }: ValueCellProps): React.ReactElement {
  return (
    <Text fontFamily="mono" fontSize="xs" color={value === null ? 'ink3' : 'ink2'}>
      {value === null ? '—' : `${(value * 100).toFixed(2)}%`}
    </Text>
  );
}

export function CnyCell({ value }: ValueCellProps): React.ReactElement {
  if (value === null) {
    return (
      <Text fontFamily="mono" fontSize="xs" color="ink3">
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
    <Text fontFamily="mono" fontSize="xs" color="ink2">
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
      <Text fontFamily="mono" fontSize="xs" color="ink3">
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
    <Text fontFamily="mono" fontSize="xs" color={color} fontWeight="600">
      {sign}
      {body}
    </Text>
  );
}
