/**
 * Pure text formatters for `StockListRow` cells — shared between the
 * MKT / EQ.LIST React grid and the terminal `selectableList` renderer.
 *
 * The React cells in `feat-eq-list/list-cells.tsx` style the same
 * values with Chakra `<Text>`; these counterparts produce plain
 * monospace strings (optionally ANSI-tinted for chg%) that fit inside
 * the xterm grid. Both surfaces must agree on rounding / sign rules so
 * a row that reads `+1.23%` in normal mode reads identically in
 * terminal mode.
 *
 * Pure (CLAUDE.md §2.5.1) — no IO, no globals.
 */

import { ANSI, paint } from '@quant/terminal';

/** Two-decimal price, `—` for null. */
export function fmtPrice(price: number | null): string {
  if (price === null || !Number.isFinite(price)) return '—';
  return price.toFixed(2);
}

/**
 * Chg% column: input is a fractional value (`0.0123` = 1.23 %). Output
 * is `±x.xx%`, color-tinted when `withColor` is true. Sign is always
 * shown for positive values to match the React `<ChgPctCell>` reading.
 */
export function fmtChgPct(value: number | null, withColor: boolean = false): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const pct = value * 100;
  const sign = pct > 0 ? '+' : '';
  const text = `${sign}${pct.toFixed(2)}%`;
  if (!withColor) return text;
  if (pct > 0) return paint(text, ANSI.green);
  if (pct < 0) return paint(text, ANSI.red);
  return text;
}

/** Unsigned percent (turnover rate / margin). Input fractional. */
export function fmtPct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(2)}%`;
}

/** CNY amount — collapses to `亿` / `万` units, matches `<CnyCell>`. */
export function fmtCny(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const yi = 1e8;
  const wan = 1e4;
  if (value >= yi) return `${(value / yi).toFixed(2)}亿`;
  if (value >= wan) return `${(value / wan).toFixed(0)}万`;
  return value.toFixed(0);
}

/** Consecutive-up days. Renders `0d` instead of `—` to match MKT. */
export function fmtConsecUp(days: number | null): string {
  if (days === null || !Number.isFinite(days)) return '—';
  return `${String(days)}d`;
}

/** Plain ratio cell (PE / PB / PEG) — two decimals, `—` for null. */
export function fmtRatio(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return value.toFixed(2);
}
