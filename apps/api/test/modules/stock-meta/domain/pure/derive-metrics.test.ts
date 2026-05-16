/**
 * Unit tests for `deriveMetrics` — pure port of the Python
 * `derive_metrics`. Mirrors the test groupings in
 * `services/py/tests/unit/quant_core/domain/pure/test_derive_metrics.py`
 * so drift between the two implementations is caught early.
 */

import type { QuarterlyFinancials, StockMetaDto } from '@quant/shared';

import { D } from '../../../../../src/modules/stock-meta/domain/pure/decimal-config.js';
import { deriveMetrics } from '../../../../../src/modules/stock-meta/domain/pure/derive-metrics.js';

function meta(overrides: Partial<StockMetaDto> = {}): StockMetaDto {
  return {
    code: '600519',
    name: '贵州茅台',
    name_pinyin: 'GZMT',
    industries: '食品饮料,白酒',
    list_date: '2001-08-27',
    float_pct: '0.8',
    updated_at: '2026-05-01T00:00:00+00:00',
    total_share: '1000',
    float_share: '800',
    net_assets: '5000',
    net_assets_period: '2025-09-30',
    quarterlies: [],
    financials_updated_at: '2026-05-01T00:00:00+00:00',
    ...overrides,
  };
}

function q(
  period: string,
  netProfit: string | null,
  revenue: string | null = null,
  cost: string | null = null,
): QuarterlyFinancials {
  return {
    period,
    revenue,
    operating_cost: cost,
    net_profit: netProfit,
    net_profit_excl_nr: netProfit,
  };
}

const EIGHT_PERIODS = [
  '2023-12-31',
  '2024-03-31',
  '2024-06-30',
  '2024-09-30',
  '2024-12-31',
  '2025-03-31',
  '2025-06-30',
  '2025-09-30',
] as const;

function eightQuarters(netProfits: readonly string[]): QuarterlyFinancials[] {
  expect(netProfits).toHaveLength(8);
  return EIGHT_PERIODS.map((p, i) => q(p, netProfits[i]!, '100', '40'));
}

describe('deriveMetrics — mkt_cap / float_mkt_cap', () => {
  it('golden path multiplies shares by price', () => {
    const d = deriveMetrics(meta(), new D('100'));
    expect(d.mkt_cap?.toString()).toBe('100000');
    expect(d.float_mkt_cap?.toString()).toBe('80000');
  });

  it('null price → every metric null', () => {
    const d = deriveMetrics(meta(), null);
    expect(d.mkt_cap).toBeNull();
    expect(d.float_mkt_cap).toBeNull();
    expect(d.pe_ttm).toBeNull();
    expect(d.pb).toBeNull();
  });

  it('zero price → every metric null', () => {
    const d = deriveMetrics(meta(), new D('0'));
    expect(d.mkt_cap).toBeNull();
  });

  it('missing total_share zeroes only mkt_cap', () => {
    const d = deriveMetrics(meta({ total_share: null }), new D('100'));
    expect(d.mkt_cap).toBeNull();
  });

  it('missing float_share keeps mkt_cap intact', () => {
    const d = deriveMetrics(meta({ float_share: null }), new D('100'));
    expect(d.float_mkt_cap).toBeNull();
    expect(d.mkt_cap?.toString()).toBe('100000');
  });
});

describe('deriveMetrics — pe_ttm', () => {
  it('golden: mkt_cap / sum(last-4 net_profit)', () => {
    const d = deriveMetrics(
      meta({ quarterlies: eightQuarters(['10', '10', '10', '10', '10', '10', '10', '10']) }),
      new D('100'),
    );
    expect(d.pe_ttm?.toString()).toBe('2500');
  });

  it('fewer than 4 quarters → null', () => {
    const d = deriveMetrics(meta({ quarterlies: [q('2025-09-30', '10')] }), new D('100'));
    expect(d.pe_ttm).toBeNull();
  });

  it('any missing net_profit in the trailing 4 → null', () => {
    const quarters = eightQuarters(['10', '10', '10', '10', '10', '10', '10', '10']);
    quarters[quarters.length - 1] = q('2025-09-30', null);
    const d = deriveMetrics(meta({ quarterlies: quarters }), new D('100'));
    expect(d.pe_ttm).toBeNull();
  });

  it('zero TTM profit → null', () => {
    const d = deriveMetrics(
      meta({ quarterlies: eightQuarters(['0', '0', '0', '0', '0', '0', '0', '0']) }),
      new D('100'),
    );
    expect(d.pe_ttm).toBeNull();
  });
});

describe('deriveMetrics — pe_dynamic (EastMoney style)', () => {
  it('Q3 annualises by 4/3', () => {
    // net_profit 30 → annualised 40 → mkt_cap 100_000 / 40 = 2500
    const d = deriveMetrics(meta({ quarterlies: [q('2025-09-30', '30')] }), new D('100'));
    expect(d.pe_dynamic?.toString()).toBe('2500');
  });

  it('Q4 annualises by 4/4', () => {
    const d = deriveMetrics(meta({ quarterlies: [q('2024-12-31', '40')] }), new D('100'));
    expect(d.pe_dynamic?.toString()).toBe('2500');
  });

  it('Q1 annualises by 4/1', () => {
    const d = deriveMetrics(meta({ quarterlies: [q('2025-03-31', '10')] }), new D('100'));
    expect(d.pe_dynamic?.toString()).toBe('2500');
  });

  it('negative latest profit → null', () => {
    const d = deriveMetrics(meta({ quarterlies: [q('2025-09-30', '-1')] }), new D('100'));
    expect(d.pe_dynamic).toBeNull();
  });

  it('no quarterlies → null', () => {
    const d = deriveMetrics(meta(), new D('100'));
    expect(d.pe_dynamic).toBeNull();
  });

  it('off-quarter period → null', () => {
    const d = deriveMetrics(meta({ quarterlies: [q('2025-07-31', '10')] }), new D('100'));
    expect(d.pe_dynamic).toBeNull();
  });
});

describe('deriveMetrics — pb', () => {
  it('golden: mkt_cap / net_assets', () => {
    const d = deriveMetrics(meta(), new D('100'));
    expect(d.pb?.toString()).toBe('20');
  });

  it('missing net_assets → null', () => {
    const d = deriveMetrics(meta({ net_assets: null }), new D('100'));
    expect(d.pb).toBeNull();
  });

  it('zero net_assets → null', () => {
    const d = deriveMetrics(meta({ net_assets: '0' }), new D('100'));
    expect(d.pb).toBeNull();
  });
});

describe('deriveMetrics — peg', () => {
  it('golden: pe_ttm / growth_pct', () => {
    const d = deriveMetrics(
      meta({ quarterlies: eightQuarters(['10', '10', '10', '10', '20', '20', '20', '20']) }),
      new D('100'),
    );
    expect(d.pe_ttm?.toString()).toBe('1250');
    expect(d.peg?.toString()).toBe('12.5');
  });

  it('fewer than 8 quarters → null', () => {
    const quarterlies = [
      q('2025-03-31', '10'),
      q('2025-06-30', '10'),
      q('2025-09-30', '10'),
      q('2025-12-31', '10'),
    ];
    const d = deriveMetrics(meta({ quarterlies }), new D('100'));
    expect(d.pe_ttm).not.toBeNull();
    expect(d.peg).toBeNull();
  });

  it('negative growth → null', () => {
    const d = deriveMetrics(
      meta({ quarterlies: eightQuarters(['20', '20', '20', '20', '10', '10', '10', '10']) }),
      new D('100'),
    );
    expect(d.peg).toBeNull();
  });

  it('prior-period loss → null', () => {
    const d = deriveMetrics(
      meta({ quarterlies: eightQuarters(['-5', '-5', '-5', '-5', '10', '10', '10', '10']) }),
      new D('100'),
    );
    expect(d.peg).toBeNull();
  });
});

describe('deriveMetrics — gross_margin_ttm', () => {
  it('golden: (rev - cost) / rev over last 4 quarters', () => {
    const quarterlies = ['2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31'].map((p) =>
      q(p, '10', '100', '40'),
    );
    const d = deriveMetrics(meta({ quarterlies }), new D('100'));
    expect(d.gross_margin_ttm?.toString()).toBe('0.6');
  });

  it('fewer than 4 quarters → null', () => {
    const d = deriveMetrics(
      meta({ quarterlies: [q('2025-09-30', '10', '100', '40')] }),
      new D('100'),
    );
    expect(d.gross_margin_ttm).toBeNull();
  });

  it('missing revenue in any quarter → null', () => {
    const quarterlies = ['2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31'].map((p) =>
      q(p, '10', '100', '40'),
    );
    quarterlies[quarterlies.length - 1] = q('2025-12-31', '10', null, '40');
    const d = deriveMetrics(meta({ quarterlies }), new D('100'));
    expect(d.gross_margin_ttm).toBeNull();
  });

  it('zero revenue → null', () => {
    const quarterlies = ['2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31'].map((p) =>
      q(p, '10', '0', '0'),
    );
    const d = deriveMetrics(meta({ quarterlies }), new D('100'));
    expect(d.gross_margin_ttm).toBeNull();
  });
});

describe('deriveMetrics — precision regression', () => {
  it('preserves decimal precision on large mkt_cap', () => {
    // Float-inexact price (50.05) × large share count must not drift.
    // decimal.js strips trailing zeros (Py `Decimal` keeps the
    // contextual scale), so compare numerically rather than by string.
    const d = deriveMetrics(meta({ total_share: '8134600000', float_share: null }), new D('50.05'));
    const mktCap = d.mkt_cap;
    if (mktCap === null) throw new Error('mkt_cap unexpectedly null');
    expect(mktCap.eq(new D('407136730000.00'))).toBe(true);
  });
});
