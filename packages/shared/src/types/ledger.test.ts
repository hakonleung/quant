import { describe, expect, it } from 'vitest';

import {
  EnrichedLedgerEntrySchema,
  LedgerAnalysisSchema,
  LedgerEntrySchema,
  LedgerSnapshotSchema,
} from './ledger.js';

describe('LedgerEntrySchema', () => {
  it('parses an entry with closingPosition', () => {
    expect(() =>
      LedgerEntrySchema.parse({
        date: '2026-05-01',
        pnlAmount: '1234.56',
        closingPosition: '105000',
      }),
    ).not.toThrow();
  });

  it('parses an entry without closingPosition (chained)', () => {
    expect(() => LedgerEntrySchema.parse({ date: '2026-05-02', pnlAmount: '-200' })).not.toThrow();
  });

  it('parses an entry with closingPosition: null', () => {
    expect(() =>
      LedgerEntrySchema.parse({
        date: '2026-05-02',
        pnlAmount: '-200',
        closingPosition: null,
      }),
    ).not.toThrow();
  });

  it('rejects malformed date', () => {
    expect(() => LedgerEntrySchema.parse({ date: '2026/05/01', pnlAmount: '0' })).toThrow();
  });

  it('rejects non-decimal pnlAmount', () => {
    expect(() => LedgerEntrySchema.parse({ date: '2026-05-01', pnlAmount: '1.2.3' })).toThrow();
  });

  it('rejects unknown extra keys (strict)', () => {
    expect(() =>
      LedgerEntrySchema.parse({
        date: '2026-05-01',
        pnlAmount: '0',
        surprise: true,
      }),
    ).toThrow();
  });
});

describe('LedgerSnapshotSchema', () => {
  it('parses an empty snapshot', () => {
    expect(LedgerSnapshotSchema.parse({ entries: [] })).toEqual({ entries: [] });
  });
});

describe('EnrichedLedgerEntrySchema', () => {
  it('round-trips a fully populated enriched row', () => {
    expect(() =>
      EnrichedLedgerEntrySchema.parse({
        date: '2026-05-01',
        pnlAmount: '100',
        closingPosition: '10100',
        derivedClosingPosition: '10100',
        closingProvided: true,
        derivedDailyPct: '1',
        cashFlow: '0',
      }),
    ).not.toThrow();
  });
});

describe('LedgerAnalysisSchema', () => {
  it('rejects extra keys (strict)', () => {
    expect(() =>
      LedgerAnalysisSchema.parse({
        summary: 's',
        operationStyle: 'o',
        marketView: 'm',
        recommendations: [],
        generatedAt: '2026-05-08T00:00:00+00:00',
        windowStart: '2026-04-08',
        windowEnd: '2026-05-08',
        entryCount: 0,
        provider: 'moonshot',
        rogue: 1,
      }),
    ).toThrow();
  });
});
