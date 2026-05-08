import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';

import type { LedgerEntry } from '../types/ledger.js';
import {
  currentPosition,
  daysSinceFirst,
  dedupeByDate,
  enrichEntries,
  initialPosition,
  mergeEntries,
  seriesCumulativePosition,
  seriesDailyPnl,
  seriesDailyPnlNoAnchor,
  seriesKline,
  sortEntries,
  totalCashFlow,
  totalPnlAmount,
  totalReturnPct,
  validateLedger,
} from './ledger.js';

const e = (date: string, pnl: string, closing?: string | null): LedgerEntry => ({
  date,
  pnlAmount: pnl,
  ...(closing !== undefined && { closingPosition: closing }),
});

describe('sortEntries / dedupeByDate / mergeEntries', () => {
  it('sortEntries returns ascending', () => {
    const sorted = sortEntries([
      e('2026-05-03', '0', '100'),
      e('2026-05-01', '0', '99'),
      e('2026-05-02', '0', '101'),
    ]);
    expect(sorted.map((x) => x.date)).toEqual(['2026-05-01', '2026-05-02', '2026-05-03']);
  });

  it('dedupeByDate keeps the last occurrence', () => {
    const out = dedupeByDate([e('2026-05-01', '0', '100'), e('2026-05-01', '50', '150')]);
    expect(out).toHaveLength(1);
    expect(out[0]?.pnlAmount).toBe('50');
  });

  it('mergeEntries imports overwrite existing on date collision', () => {
    const existing: LedgerEntry[] = [e('2026-05-01', '0', '100'), e('2026-05-02', '10')];
    const incoming: LedgerEntry[] = [e('2026-05-02', '99'), e('2026-05-03', '5')];
    const out = mergeEntries(existing, incoming);
    expect(out).toHaveLength(3);
    expect(out.find((x) => x.date === '2026-05-02')?.pnlAmount).toBe('99');
    expect(out.find((x) => x.date === '2026-05-03')?.pnlAmount).toBe('5');
  });
});

describe('validateLedger', () => {
  it('empty snapshot is valid', () => {
    expect(validateLedger([])).toEqual({ ok: true });
  });

  it('rejects when earliest entry has no closingPosition (undefined)', () => {
    const res = validateLedger([e('2026-05-01', '10')]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('LEDGER_FIRST_NEEDS_CLOSING_POSITION');
    }
  });

  it('rejects when earliest entry has closingPosition: null', () => {
    const res = validateLedger([e('2026-05-01', '10', null)]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('LEDGER_FIRST_NEEDS_CLOSING_POSITION');
    }
  });

  it('accepts when only the earliest entry has closingPosition', () => {
    const res = validateLedger([
      e('2026-05-01', '0', '100000'),
      e('2026-05-02', '500'),
      e('2026-05-03', '-200'),
    ]);
    expect(res.ok).toBe(true);
  });

  it('rejects on duplicate dates', () => {
    const res = validateLedger([e('2026-05-01', '0', '100000'), e('2026-05-01', '5')]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('LEDGER_DUPLICATE_DATE');
  });

  it('checks anchor on the EARLIEST entry, not insertion order', () => {
    // Adding a non-first-in-order entry first that lacks closing is fine
    // as long as the *earliest* date carries the anchor.
    const res = validateLedger([e('2026-05-02', '500'), e('2026-05-01', '0', '100000')]);
    expect(res.ok).toBe(true);
  });
});

describe('enrichEntries', () => {
  it('returns [] for an empty input', () => {
    expect(enrichEntries([])).toEqual([]);
  });

  it('throws when caller skipped validateLedger and anchor is missing', () => {
    expect(() => enrichEntries([e('2026-05-01', '10')])).toThrow();
  });

  it('chain-fills missing closingPositions', () => {
    const out = enrichEntries([
      e('2026-05-01', '500', '100500'),
      e('2026-05-02', '-200'),
      e('2026-05-03', '300'),
    ]);
    expect(out.map((x) => x.derivedClosingPosition)).toEqual(['100500', '100300', '100600']);
    expect(out.map((x) => x.closingProvided)).toEqual([true, false, false]);
  });

  it('captures cashFlow when explicit closing diverges from prev + pnl', () => {
    const out = enrichEntries([
      e('2026-05-01', '0', '100000'), // anchor: implicit pre-day = 100000
      e('2026-05-02', '500', '105500'), // expected 100500, got 105500 → cashFlow = +5000
    ]);
    expect(out[1]?.cashFlow).toBe('5000');
    expect(out[1]?.derivedClosingPosition).toBe('105500');
  });

  it('cashFlow is 0 when chain-derived', () => {
    const out = enrichEntries([e('2026-05-01', '0', '100000'), e('2026-05-02', '500')]);
    expect(out[1]?.cashFlow).toBe('0');
  });

  it('derivedDailyPct = pnlAmount / prevClosing × 100', () => {
    // Day 1: prev = 100000 - 1000 = 99000; pct = 1000 / 99000 * 100
    const out = enrichEntries([e('2026-05-01', '1000', '100000')]);
    const expected = new Decimal('1000').dividedBy('99000').times(100).toString();
    expect(out[0]?.derivedDailyPct).toBe(expected);
  });

  it('derivedDailyPct = 0 when prev = 0 (anchor closingPosition equals pnlAmount)', () => {
    const out = enrichEntries([e('2026-05-01', '500', '500')]);
    expect(out[0]?.derivedDailyPct).toBe('0');
  });
});

describe('summary helpers', () => {
  const enriched = enrichEntries([
    e('2026-05-01', '0', '100000'),
    e('2026-05-02', '500'),
    e('2026-05-03', '-200'),
  ]);

  it('totalPnlAmount sums daily PnL', () => {
    expect(totalPnlAmount(enriched)).toBe('300');
  });

  it('totalCashFlow sums implicit cash flow', () => {
    expect(totalCashFlow(enriched)).toBe('0');
  });

  it('currentPosition = last derived closing', () => {
    expect(currentPosition(enriched)).toBe('100300');
  });

  it('initialPosition = first.closing − first.pnl', () => {
    expect(initialPosition(enriched)).toBe('100000');
  });

  it('totalReturnPct = (current − first.closing) / first.closing × 100, excluding anchor', () => {
    // baseline = first.derivedClosing = 100000 (anchor, excluded from PnL)
    // current = 100300; growth across days 2..n = 300 → 0.3 %
    expect(totalReturnPct(enriched)).toBe('0.3');
  });

  it('totalReturnPct = 0 on empty / single-entry snapshots', () => {
    expect(totalReturnPct([])).toBe('0');
    const single = enrichEntries([e('2026-05-01', '0', '100000')]);
    expect(totalReturnPct(single)).toBe('0');
  });

  it('totalReturnPct excludes anchor PnL even when first.pnlAmount is large', () => {
    // First entry brought account to 500k from an implicit 1.18M; that
    // -680k drawdown is anchor history, so the user-visible total return
    // measures growth from 500k onward. (500 → 600) / 500 = +20%.
    const enriched2 = enrichEntries([
      e('2024-10-01', '-680000', '500000'),
      e('2024-10-02', '100000'),
    ]);
    expect(totalReturnPct(enriched2)).toBe('20');
  });

  it('totalReturnPct = 0 when baseline (first.derivedClosing) = 0', () => {
    const flat = enrichEntries([e('2026-05-01', '500', '0'), e('2026-05-02', '0')]);
    expect(totalReturnPct(flat)).toBe('0');
  });

  it('daysSinceFirst counts full calendar days since earliest entry', () => {
    expect(daysSinceFirst(enriched, '2026-05-08')).toBe(7);
  });

  it('daysSinceFirst is 0 for empty / future-dated input', () => {
    expect(daysSinceFirst([], '2026-05-08')).toBe(0);
    expect(daysSinceFirst(enriched, '2026-04-30')).toBe(0);
  });
});

describe('chart series', () => {
  const enriched = enrichEntries([
    e('2026-05-01', '0', '100000'),
    e('2026-05-02', '500'),
    e('2026-05-03', '-200'),
  ]);

  it('seriesDailyPnl includes every entry', () => {
    const out = seriesDailyPnl(enriched);
    expect(out.map((p) => p.date)).toEqual(['2026-05-01', '2026-05-02', '2026-05-03']);
  });

  it('seriesDailyPnlNoAnchor drops the first (anchor) row', () => {
    const out = seriesDailyPnlNoAnchor(enriched);
    expect(out.map((p) => p.date)).toEqual(['2026-05-02', '2026-05-03']);
    expect(out.map((p) => p.value)).toEqual(['500', '-200']);
  });

  it('seriesDailyPnlNoAnchor returns [] for ≤1 entries', () => {
    expect(seriesDailyPnlNoAnchor([])).toEqual([]);
    const single = enrichEntries([e('2026-05-01', '0', '100000')]);
    expect(seriesDailyPnlNoAnchor(single)).toEqual([]);
  });

  it('seriesCumulativePosition uses derivedClosingPosition', () => {
    const out = seriesCumulativePosition(enriched);
    expect(out.map((p) => p.value)).toEqual(['100000', '100500', '100300']);
  });

  it('seriesKline = one candle per non-anchor entry; open = prev close, close = this close', () => {
    const candles = seriesKline(enriched);
    expect(candles).toEqual([
      {
        date: '2026-05-02',
        open: '100000',
        close: '100500',
        direction: 'up',
        closingProvided: false,
        cashFlow: '0',
      },
      {
        date: '2026-05-03',
        open: '100500',
        close: '100300',
        direction: 'down',
        closingProvided: false,
        cashFlow: '0',
      },
    ]);
  });

  it('seriesKline marks flat candles (open == close) when there is no PnL or cashflow', () => {
    const flat = enrichEntries([e('2026-05-01', '0', '100000'), e('2026-05-02', '0')]);
    const candles = seriesKline(flat);
    expect(candles).toHaveLength(1);
    expect(candles[0]?.direction).toBe('flat');
  });

  it('seriesKline returns [] for ≤1 entries', () => {
    expect(seriesKline([])).toEqual([]);
    const single = enrichEntries([e('2026-05-01', '0', '100000')]);
    expect(seriesKline(single)).toEqual([]);
  });
});
