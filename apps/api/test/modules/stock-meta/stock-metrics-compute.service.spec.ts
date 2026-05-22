/**
 * Focused unit tests for the wcmi-serialisation behaviour of
 * `StockMetricsComputeService.toRowWithWcmi`. Regression: tiny composite
 * scores produced by float roundoff in `scoreUniverse` used to ship as
 * scientific-notation strings (e.g. `"5.26e-14"`), which the shared
 * `decimalStringOrNull` zod schema rejects with "expected decimal as
 * string" — propagating as a 500 on read.
 */

import type { KlineBar, StockMetaDto } from '@quant/shared';

import type { KlineReaderService } from '../../../src/modules/kline/kline-reader.service.js';
import type { LocalStockMetaAdapter } from '../../../src/modules/stock-meta/local-stock-meta.adapter.js';
import { StockMetricsComputeService } from '../../../src/modules/stock-meta/stock-metrics-compute.service.js';
import type { WcmiScore } from '../../../src/modules/stock-meta/domain/pure/wcmi-scoring.js';

const META: StockMetaDto = {
  code: '600000',
  name: '测试',
  name_pinyin: 'CS',
  industries: 'bank',
  list_date: '2020-01-01',
  float_pct: '1',
  updated_at: '2026-05-01T00:00:00+00:00',
  total_share: null,
  float_share: null,
  net_assets: null,
  net_assets_period: null,
  quarterlies: [],
  financials_updated_at: null,
};

function flatBar(i: number, close: number): KlineBar {
  return {
    date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
    open: close,
    high: close,
    low: close,
    close,
    volume: 0,
    turnover: 0,
    turnoverRate: 0,
    ma5: null,
    ma10: null,
    ma20: null,
    ma60: null,
  };
}

function makeService(): StockMetricsComputeService {
  const metaAdapter = {} as unknown as LocalStockMetaAdapter;
  const klineReader = {} as unknown as KlineReaderService;
  return new StockMetricsComputeService(metaAdapter, klineReader);
}

function score(composite: number): WcmiScore {
  return {
    composite,
    pct: {
      rhythm: 0.5,
      maSupport: 0.5,
      upWaveSmoothness: 0.5,
      yangDominance: 0.5,
      upperShadowClean: 0.5,
      stageGain: 0.5,
      crashAvoidance: 0.5, recentStrength: 0.5,
    },
  };
}

describe('StockMetricsComputeService.toRowWithWcmi', () => {
  const service = makeService();
  const bars = Array.from({ length: 12 }, (_, i) => flatBar(i, 10 + i));
  const decimalRe = /^-?\d+(\.\d+)?$/;

  it('serialises a tiny near-zero composite as a plain decimal (no scientific notation)', () => {
    const row = service.toRowWithWcmi(META, bars, score(5.26e-14));
    expect(row.wcmi).not.toBeNull();
    expect(decimalRe.test(row.wcmi!)).toBe(true);
  });

  it('passes plain composite values through as decimal strings', () => {
    const row = service.toRowWithWcmi(META, bars, score(705.683182));
    expect(row.wcmi).toBe('705.68');
    expect(decimalRe.test(row.wcmi!)).toBe(true);
  });

  it('preserves null when no score is computable', () => {
    const row = service.toRowWithWcmi(META, bars, null);
    expect(row.wcmi).toBeNull();
    expect(row.wcmi_rhythm).toBeNull();
    expect(row.wcmi_crash_avoid).toBeNull();
  });

  it('serialises each pct breakdown as a 2-decimal percent string', () => {
    const row = service.toRowWithWcmi(META, bars, {
      composite: 500,
      pct: {
        rhythm: 0.734,
        maSupport: 1,
        upWaveSmoothness: 0,
        yangDominance: 0.5,
        upperShadowClean: 0.123456,
        stageGain: 0.9,
        crashAvoidance: 0.25, recentStrength: 0.25,
      },
    });
    expect(row.wcmi_rhythm).toBe('73.40');
    expect(row.wcmi_ma_support).toBe('100.00');
    expect(row.wcmi_up_wave).toBe('0.00');
    expect(row.wcmi_shadow_clean).toBe('12.35');
    for (const v of [
      row.wcmi_rhythm,
      row.wcmi_ma_support,
      row.wcmi_up_wave,
      row.wcmi_yang_dom,
      row.wcmi_shadow_clean,
      row.wcmi_stage_gain,
      row.wcmi_crash_avoid,
    ]) {
      expect(decimalRe.test(v!)).toBe(true);
    }
  });
});
