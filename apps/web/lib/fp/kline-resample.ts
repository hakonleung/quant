/**
 * Pure resampling of daily K-line bars into weekly / monthly bars
 * (CLAUDE.md §2.5.1 — pure functions live in `lib/fp/`).
 *
 * Daily bars are assumed to be sorted ascending by `date` (the kline
 * API guarantees this). MA fields on the input are ignored — they are
 * precomputed against the daily series and meaningless once we bucket
 * — so we recompute MA5/10/20/60 over the resampled close series.
 */

import type { KlineBar } from '@quant/shared';

export const KlinePeriods = ['D', 'W', 'M'] as const;
export type KlinePeriod = (typeof KlinePeriods)[number];

const MS_PER_DAY = 86_400_000;

/**
 * ISO-8601 week number for a date string (`YYYY-MM-DD`). Weeks start
 * on Monday; the week containing the year's first Thursday is week 1.
 * Returns the `${isoWeekYear}-W${week.padStart(2,'0')}` key — the ISO
 * week year can differ from the calendar year near Jan 1 / Dec 31.
 */
function isoWeekKey(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dow);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((dt.getTime() - yearStart.getTime()) / MS_PER_DAY + 1) / 7);
  return `${String(dt.getUTCFullYear())}-W${String(week).padStart(2, '0')}`;
}

function monthKey(date: string): string {
  return date.slice(0, 7);
}

function groupKey(period: KlinePeriod, date: string): string {
  if (period === 'W') return isoWeekKey(date);
  if (period === 'M') return monthKey(date);
  return date;
}

/**
 * Simple moving average over the close series. Returns `null` for any
 * index < window - 1 (insufficient history).
 */
function sma(closes: readonly number[], window: number): readonly (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (window <= 0) return out;
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i]!;
    if (i >= window) sum -= closes[i - window]!;
    if (i >= window - 1) out[i] = sum / window;
  }
  return out;
}

export function resampleBars(
  bars: readonly KlineBar[],
  period: KlinePeriod,
): readonly KlineBar[] {
  if (period === 'D' || bars.length === 0) return bars;

  interface Bucket {
    key: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    turnover: number;
    turnoverRate: number;
    date: string;
  }
  const buckets: Bucket[] = [];
  let last: Bucket | null = null;
  for (const b of bars) {
    const key = groupKey(period, b.date);
    if (last === null || last.key !== key) {
      last = {
        key,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
        turnover: b.turnover,
        turnoverRate: b.turnoverRate,
        date: b.date,
      };
      buckets.push(last);
      continue;
    }
    last.high = Math.max(last.high, b.high);
    last.low = Math.min(last.low, b.low);
    last.close = b.close;
    last.volume += b.volume;
    last.turnover += b.turnover;
    last.turnoverRate += b.turnoverRate;
    last.date = b.date;
  }

  const closes = buckets.map((b) => b.close);
  const ma5 = sma(closes, 5);
  const ma10 = sma(closes, 10);
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);

  return buckets.map(
    (b, i): KlineBar => ({
      date: b.date,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
      turnover: b.turnover,
      turnoverRate: b.turnoverRate,
      ma5: ma5[i] ?? null,
      ma10: ma10[i] ?? null,
      ma20: ma20[i] ?? null,
      ma60: ma60[i] ?? null,
    }),
  );
}
