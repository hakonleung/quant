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
  const valid = {
    coreMetrics: {
      winRatePct: 65.5,
      pnlRatio: 1.8,
      maxDrawdown: { valuePct: -12.3, startDate: '2026-04-10', endDate: '2026-04-22' },
      profitConcentration: { level: 'high', corePeriod: '4.11-4.13', contributionPct: 78 },
      netCashFlow: { status: 'inflow', amount: '5000' },
    },
    behavioralProfiling: {
      patternDependency: '极度依赖趋势跟随',
      disciplineBreaches: [{ date: '2026-04-15', pnlPct: -5.2, analysis: '扛单' }],
      emotionalVolatility: '末期重仓博弈',
    },
    marketMicrostructure: [{ timeframe: '4.11-4.13', environment: '强主线顺风期' }],
    systemicInterventions: [
      {
        command: 'SET_MAX_DRAWDOWN_LIMIT',
        condition: 'WIN_STREAK >= 5',
        action: 'HALT_TRADING_24H',
        rationale: '连胜后情绪化',
      },
    ],
    generatedAt: '2026-05-08T00:00:00+00:00',
    windowStart: '2026-04-08',
    windowEnd: '2026-05-08',
    entryCount: 20,
    provider: 'moonshot',
  };

  it('parses a fully populated analysis', () => {
    expect(() => LedgerAnalysisSchema.parse(valid)).not.toThrow();
  });

  it('accepts pnlRatio = null', () => {
    expect(() =>
      LedgerAnalysisSchema.parse({
        ...valid,
        coreMetrics: { ...valid.coreMetrics, pnlRatio: null },
      }),
    ).not.toThrow();
  });

  it('accepts empty breaches / phases / interventions', () => {
    expect(() =>
      LedgerAnalysisSchema.parse({
        ...valid,
        behavioralProfiling: { ...valid.behavioralProfiling, disciplineBreaches: [] },
        marketMicrostructure: [],
        systemicInterventions: [],
      }),
    ).not.toThrow();
  });

  it('rejects extra keys (strict)', () => {
    expect(() => LedgerAnalysisSchema.parse({ ...valid, rogue: 1 })).toThrow();
  });

  it('rejects bad concentration level', () => {
    expect(() =>
      LedgerAnalysisSchema.parse({
        ...valid,
        coreMetrics: {
          ...valid.coreMetrics,
          profitConcentration: {
            ...valid.coreMetrics.profitConcentration,
            level: 'extreme',
          },
        },
      }),
    ).toThrow();
  });

  it('rejects non-decimal cash-flow amount', () => {
    expect(() =>
      LedgerAnalysisSchema.parse({
        ...valid,
        coreMetrics: {
          ...valid.coreMetrics,
          netCashFlow: { status: 'none', amount: 'lots' },
        },
      }),
    ).toThrow();
  });
});
