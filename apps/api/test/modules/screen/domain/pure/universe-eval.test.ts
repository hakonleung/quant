/**
 * Unit tests for the universe-screen evaluator. Mirrors the Py
 * `tests/unit/quant_core/domain/rules/test_universe_eval.py` cases.
 */

import type { StockMetaDto, UniversePlanAst } from '@quant/shared';

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
