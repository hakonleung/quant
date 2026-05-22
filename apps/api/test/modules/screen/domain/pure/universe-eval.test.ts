/**
 * Unit tests for the universe-screen evaluator. Mirrors the Py
 * `tests/unit/quant_core/domain/rules/test_universe_eval.py` cases.
 */

import type { StockMetaDto, StockSnapshotDto, UniversePlanAst } from '@quant/shared';

import { evaluateUniverse } from '../../../../../src/modules/screen/domain/pure/universe-eval.js';

function meta(overrides: Partial<StockMetaDto> = {}): StockMetaDto {
  return {
    code: '600519',
    name: '贵州茅台',
    name_pinyin: 'GZMT',
    industries: '食品饮料,白酒',
    list_date: '2001-08-27',
    float_pct: '0.8',
    updated_at: '2026-05-01T00:00:00+00:00',
    total_share: null,
    float_share: null,
    net_assets: null,
    net_assets_period: null,
    quarterlies: [],
    financials_updated_at: null,
    ...overrides,
  };
}

function plan(expr: UniversePlanAst['expr']): UniversePlanAst {
  return { asof: '2026-05-16', expr };
}

describe('evaluateUniverse', () => {
  it('contains: industries substring match', () => {
    const result = evaluateUniverse(
      plan({
        kind: 'compare',
        op: 'contains',
        left: { kind: 'field', field: 'industries' },
        right: { kind: 'const', value: '白酒' },
      }),
      [meta(), meta({ code: '600000', name: '浦发银行', industries: '银行' })],
    );
    expect(result.map((m) => m.code)).toEqual(['600519']);
  });

  it('is_st derived field', () => {
    const result = evaluateUniverse(
      plan({
        kind: 'compare',
        op: 'eq',
        left: { kind: 'field', field: 'is_st' },
        right: { kind: 'const', value: true },
      }),
      [meta({ code: '600519', name: '贵州茅台' }), meta({ code: '600000', name: 'ST 黑科技' })],
    );
    expect(result.map((m) => m.code)).toEqual(['600000']);
  });

  it('exchange derived from code prefix', () => {
    const result = evaluateUniverse(
      plan({
        kind: 'compare',
        op: 'eq',
        left: { kind: 'field', field: 'exchange' },
        right: { kind: 'const', value: 'sz' },
      }),
      [
        meta({ code: '000001', name: '平安银行' }),
        meta({ code: '600519', name: '贵州茅台' }),
        meta({ code: '300750', name: '宁德时代' }),
      ],
    );
    expect(result.map((m) => m.code).sort()).toEqual(['000001', '300750']);
  });

  it('listed_days vs const number', () => {
    const result = evaluateUniverse(
      plan({
        kind: 'compare',
        op: 'gt',
        left: { kind: 'field', field: 'listed_days' },
        right: { kind: 'const', value: 100 },
      }),
      [
        meta({ code: '600519', list_date: '2001-08-27' }),
        meta({ code: '300999', list_date: '2026-05-15' }),
      ],
    );
    expect(result.map((m) => m.code)).toEqual(['600519']);
  });

  // ---- Snapshot / DDE-side fields (option B universe expansion) ----

  function snap(
    code: string,
    overrides: {
      derived?: Partial<StockSnapshotDto['derived']>;
      returns?: Partial<StockSnapshotDto['returns']>;
      dde?: Partial<NonNullable<StockSnapshotDto['dde']>> | null;
      price?: string | null;
    } = {},
  ): StockSnapshotDto {
    const baseDerived = {
      mkt_cap: null,
      float_mkt_cap: null,
      pe_ttm: null,
      pe_dynamic: null,
      pb: null,
      peg: null,
      gross_margin_ttm: null,
      wcmi: null,
      wcmi_rhythm: null,
      wcmi_ma_support: null,
      wcmi_up_wave: null,
      wcmi_yang_dom: null,
      wcmi_shadow_clean: null,
      wcmi_stage_gain: null,
      wcmi_crash_avoid: null, wcmi_recent_strength: null,
    };
    const baseReturns = {
      ret_1d: null,
      ret_5d: null,
      ret_10d: null,
      ret_20d: null,
      ret_90d: null,
      ret_250d: null,
    };
    const baseDde = {
      main_net_inflow_3d: null,
      main_net_inflow_5d: null,
      main_net_inflow_10d: null,
      main_net_inflow_20d: null,
      main_inflow_ratio_3d: null,
      main_inflow_ratio_5d: null,
      main_inflow_ratio_10d: null,
      main_inflow_ratio_20d: null,
    };
    return {
      meta: meta({ code }),
      price: overrides.price ?? null,
      asof: '2026-05-16',
      derived: { ...baseDerived, ...overrides.derived },
      returns: { ...baseReturns, ...overrides.returns },
      dde:
        overrides.dde === null
          ? null
          : overrides.dde === undefined
            ? null
            : { ...baseDde, ...overrides.dde },
    };
  }

  it('mkt_cap from snapshot map: filters by market cap', () => {
    const result = evaluateUniverse(
      plan({
        kind: 'compare',
        op: 'gte',
        left: { kind: 'field', field: 'mkt_cap' },
        right: { kind: 'const', value: 1e10 },
      }),
      [meta({ code: '600519' }), meta({ code: '000001' })],
      new Map([
        ['600519', snap('600519', { derived: { mkt_cap: '2.1e12' } })],
        ['000001', snap('000001', { derived: { mkt_cap: '3.5e9' } })],
      ]),
    );
    expect(result.map((m) => m.code)).toEqual(['600519']);
  });

  it('ret_5d uses returns block', () => {
    const result = evaluateUniverse(
      plan({
        kind: 'compare',
        op: 'gt',
        left: { kind: 'field', field: 'ret_5d' },
        right: { kind: 'const', value: 0.1 },
      }),
      [meta({ code: '600519' }), meta({ code: '000001' })],
      new Map([
        ['600519', snap('600519', { returns: { ret_5d: '0.15' } })],
        ['000001', snap('000001', { returns: { ret_5d: '0.05' } })],
      ]),
    );
    expect(result.map((m) => m.code)).toEqual(['600519']);
  });

  it('dde_main_net_inflow_5d (positive threshold)', () => {
    const result = evaluateUniverse(
      plan({
        kind: 'compare',
        op: 'gt',
        left: { kind: 'field', field: 'dde_main_net_inflow_5d' },
        right: { kind: 'const', value: 1e8 },
      }),
      [meta({ code: '600519' }), meta({ code: '000001' })],
      new Map([
        ['600519', snap('600519', { dde: { main_net_inflow_5d: '500000000' } })],
        ['000001', snap('000001', { dde: { main_net_inflow_5d: '50000000' } })],
      ]),
    );
    expect(result.map((m) => m.code)).toEqual(['600519']);
  });

  it('dde_main_inflow_ratio_3d supports negative thresholds (outflow)', () => {
    const result = evaluateUniverse(
      plan({
        kind: 'compare',
        op: 'lt',
        left: { kind: 'field', field: 'dde_main_inflow_ratio_3d' },
        right: { kind: 'const', value: -0.05 },
      }),
      [meta({ code: '600519' }), meta({ code: '000001' })],
      new Map([
        ['600519', snap('600519', { dde: { main_inflow_ratio_3d: '-0.12' } })],
        ['000001', snap('000001', { dde: { main_inflow_ratio_3d: '0.10' } })],
      ]),
    );
    expect(result.map((m) => m.code)).toEqual(['600519']);
  });

  it('null snapshot field excludes the row (does not throw)', () => {
    // pe_ttm > 0, but one snapshot has no pe_ttm at all → that row drops.
    const result = evaluateUniverse(
      plan({
        kind: 'compare',
        op: 'gt',
        left: { kind: 'field', field: 'pe_ttm' },
        right: { kind: 'const', value: 0 },
      }),
      [meta({ code: '600519' }), meta({ code: '000001' })],
      new Map([
        ['600519', snap('600519', { derived: { pe_ttm: '24.5' } })],
        ['000001', snap('000001')], // pe_ttm null
      ]),
    );
    expect(result.map((m) => m.code)).toEqual(['600519']);
  });

  it('missing snapshot map: snapshot fields resolve to null → exclude', () => {
    const result = evaluateUniverse(
      plan({
        kind: 'compare',
        op: 'gt',
        left: { kind: 'field', field: 'mkt_cap' },
        right: { kind: 'const', value: 0 },
      }),
      [meta({ code: '600519' })],
      // no snapshot map passed
    );
    expect(result).toEqual([]);
  });

  it('snapshot block missing entirely for a code → exclude (no crash)', () => {
    const result = evaluateUniverse(
      plan({
        kind: 'compare',
        op: 'gt',
        left: { kind: 'field', field: 'mkt_cap' },
        right: { kind: 'const', value: 0 },
      }),
      [meta({ code: '600519' }), meta({ code: '000001' })],
      new Map([['600519', snap('600519', { derived: { mkt_cap: '1e10' } })]]),
    );
    expect(result.map((m) => m.code)).toEqual(['600519']);
  });

  it('logical and / not composes', () => {
    const result = evaluateUniverse(
      plan({
        kind: 'logical',
        op: 'and',
        args: [
          {
            kind: 'compare',
            op: 'not_starts_with',
            left: { kind: 'field', field: 'name' },
            right: { kind: 'const', value: 'ST' },
          },
          {
            kind: 'compare',
            op: 'eq',
            left: { kind: 'field', field: 'exchange' },
            right: { kind: 'const', value: 'sh' },
          },
        ],
      }),
      [
        meta({ code: '600519', name: '贵州茅台' }),
        meta({ code: '600000', name: 'ST 黑科技' }),
        meta({ code: '300750', name: '宁德时代' }),
      ],
    );
    expect(result.map((m) => m.code)).toEqual(['600519']);
  });
});
