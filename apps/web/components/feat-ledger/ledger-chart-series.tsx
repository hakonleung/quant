/**
 * Series builders for `LedgerChart`. Pure data adapters — no React,
 * no DOM, no hooks. The SVG renderer in `ledger-chart.tsx` consumes
 * a {@link ChartSeries} and never reads the underlying ledger types
 * directly, so the same frame works for both modes.
 */

import {
  daysBetween,
  seriesDailyPnlNoAnchor,
  seriesKline,
  type EnrichedLedgerEntry,
} from '@quant/shared';
import { Decimal } from 'decimal.js';
import type { ReactNode } from 'react';

export interface ChartTooltip {
  /** First row: hovered day's snapshot — date + daily PnL + daily pct. */
  readonly line1: string;
  /** Second row: cumulative since the anchor — N days + total PnL + total pct. */
  readonly line2: string;
}

export interface ChartSeries {
  readonly count: number;
  readonly yMin: number;
  readonly yMax: number;
  /** Whether to draw the y=0 baseline (PnL bar mode). */
  readonly hasZero: boolean;
  readonly dateAt: (i: number) => string;
  readonly tooltipAt: (i: number) => ChartTooltip | null;
  readonly drawBar: (i: number, x: number, w: number, yFor: (v: number) => number) => ReactNode;
}

export const UP_COLOR = 'var(--chakra-colors-up)';
export const DOWN_COLOR = 'var(--chakra-colors-down)';
export const FLAT_COLOR = 'var(--chakra-colors-ink3)';
export const PANEL_COLOR = 'var(--chakra-colors-panel)';

export function buildLedgerSeries(
  mode: 'daily' | 'cumulative',
  enriched: readonly EnrichedLedgerEntry[],
  today: string,
): ChartSeries {
  return mode === 'daily' ? buildDailySeries(enriched, today) : buildKlineSeries(enriched, today);
}

function buildDailySeries(enriched: readonly EnrichedLedgerEntry[], today: string): ChartSeries {
  const points = seriesDailyPnlNoAnchor(enriched);
  // The non-anchor slice drops `enriched[0]`; entry at point i lives
  // at `enriched[i + 1]` so we can reach back for pct.
  const entries = enriched.slice(1);
  const values = points.map((p) => Number(p.value));
  // Always keep zero in view so the bar baseline is visible.
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const padded = padRange(min, max);
  return {
    count: points.length,
    yMin: padded.min,
    yMax: padded.max,
    hasZero: true,
    dateAt: (i): string => points[i]?.date ?? '',
    tooltipAt: (i): ChartTooltip | null => {
      const p = points[i];
      const e = entries[i];
      if (p === undefined || e === undefined) return null;
      return buildTooltip({
        date: p.date,
        dailyPnl: p.value,
        dailyPct: e.derivedDailyPct,
        enriched,
        fromIdx: i + 1,
        today,
      });
    },
    drawBar: (i, x, w, yFor): ReactNode => {
      const p = points[i];
      if (p === undefined) return null;
      const v = Number(p.value);
      const barW = Math.max(1, w * 0.6);
      const x0 = x + (w - barW) / 2;
      const yZero = yFor(0);
      const yV = yFor(v);
      const top = Math.min(yZero, yV);
      const h = Math.max(1, Math.abs(yZero - yV));
      const fill = v > 0 ? UP_COLOR : v < 0 ? DOWN_COLOR : FLAT_COLOR;
      return <rect x={x0} y={top} width={barW} height={h} fill={fill} />;
    },
  };
}

function buildKlineSeries(enriched: readonly EnrichedLedgerEntry[], today: string): ChartSeries {
  const candles = seriesKline(enriched);
  // `seriesKline` skips the anchor (i=0), so candle at index i pairs
  // with `enriched[i + 1]` for pnl / pct lookup.
  const entries = enriched.slice(1);
  const levels = candles.flatMap((c) => [Number(c.open), Number(c.close)]);
  const max = levels.length === 0 ? 1 : Math.max(...levels);
  const min = levels.length === 0 ? 0 : Math.min(...levels);
  const padded = padRange(min, max);
  return {
    count: candles.length,
    yMin: padded.min,
    yMax: padded.max,
    hasZero: false,
    dateAt: (i): string => candles[i]?.date ?? '',
    tooltipAt: (i): ChartTooltip | null => {
      const c = candles[i];
      const e = entries[i];
      if (c === undefined || e === undefined) return null;
      return buildTooltip({
        date: c.date,
        dailyPnl: e.pnlAmount,
        dailyPct: e.derivedDailyPct,
        enriched,
        fromIdx: i + 1,
        today,
      });
    },
    drawBar: (i, x, w, yFor): ReactNode => {
      const c = candles[i];
      return c === undefined ? null : drawCandle(c, x, w, yFor);
    },
  };
}

function drawCandle(
  c: ReturnType<typeof seriesKline>[number],
  x: number,
  w: number,
  yFor: (v: number) => number,
): ReactNode {
  const yOpen = yFor(Number(c.open));
  const yClose = yFor(Number(c.close));
  const top = Math.min(yOpen, yClose);
  const h = Math.max(1, Math.abs(yOpen - yClose));
  const fill = c.direction === 'up' ? UP_COLOR : c.direction === 'down' ? DOWN_COLOR : FLAT_COLOR;
  // 涨红 candle = filled; 跌绿 candle = hollow (panel bg + colored
  // border) — matches A-share trading software.
  const isHollow = c.direction === 'down';
  return (
    <rect
      x={x}
      y={top}
      width={w}
      height={h}
      fill={isHollow ? PANEL_COLOR : fill}
      stroke={fill}
      strokeWidth={1}
    />
  );
}

interface TooltipArgs {
  readonly date: string;
  readonly dailyPnl: string;
  readonly dailyPct: string;
  readonly enriched: readonly EnrichedLedgerEntry[];
  /** Index of the hovered entry inside `enriched`. */
  readonly fromIdx: number;
  readonly today: string;
}

/**
 * Two-line hover tooltip:
 *
 *   line 1 — `<date>  pnl <daily>  pct <daily>%`             (single-day snapshot)
 *   line 2 — `<N>d   pnl <window-pnl>  pct <window-pct>%`    (hovered → latest)
 *
 * Window PnL is the *trading* PnL only — it sums `pnlAmount` over the days
 * strictly after the hovered entry through the latest entry. Cash injections
 * / withdrawals are excluded (otherwise the user reads "+10万 since here"
 * just because they topped up the account). pct = windowPnl / hovered baseline.
 * `N` days = `today − hovered.date`.
 */
function buildTooltip(args: TooltipArgs): ChartTooltip {
  const { date, dailyPnl, dailyPct, enriched, fromIdx, today } = args;
  const line1 = `${date}  pnl ${fmtMoney(dailyPnl)}  pct ${fmtPct(dailyPct)}%`;
  const cum = windowStats(enriched, fromIdx);
  const days = fmtDaysSince(date, today);
  const line2 = `${days}  pnl ${fmtMoney(cum.pnl)}  pct ${fmtPct(cum.pct)}%`;
  return { line1, line2 };
}

function windowStats(
  enriched: readonly EnrichedLedgerEntry[],
  fromIdx: number,
): { readonly pnl: string; readonly pct: string } {
  const from = enriched[fromIdx];
  if (from === undefined) return { pnl: '0', pct: '0' };
  let pnl = new Decimal(0);
  for (let i = fromIdx + 1; i < enriched.length; i += 1) {
    const e = enriched[i];
    if (e === undefined) continue;
    pnl = pnl.plus(e.pnlAmount);
  }
  const baseline = new Decimal(from.derivedClosingPosition);
  const pct = baseline.isZero() ? new Decimal(0) : pnl.dividedBy(baseline).times(100);
  return { pnl: pnl.toString(), pct: pct.toString() };
}

function fmtDaysSince(date: string, today: string): string {
  const d = daysBetween(date, today);
  return d === null ? '' : `${String(Math.max(0, d))}d`;
}

function fmtPct(value: string): string {
  return Number(value).toFixed(2);
}

function padRange(min: number, max: number): { readonly min: number; readonly max: number } {
  if (max === min) {
    const pad = Math.max(Math.abs(min), 1) * 0.1;
    return { min: min - pad, max: max + pad };
  }
  const span = max - min;
  return { min: min - span * 0.06, max: max + span * 0.06 };
}

function fmtMoney(value: string): string {
  return new Decimal(value).toFixed(2);
}

export function fmtAxisY(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 100_000) return `${(value / 1000).toFixed(0)}k`;
  if (abs >= 10_000) return `${(value / 1000).toFixed(1)}k`;
  return value.toFixed(abs >= 100 ? 0 : 2);
}
