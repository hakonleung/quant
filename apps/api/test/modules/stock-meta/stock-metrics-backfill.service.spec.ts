import type { KlineBar, StockMetaDto, StockSnapshotDto } from '@quant/shared';

import type { KlineReaderService } from '../../../src/modules/kline/kline-reader.service.js';
import type { WcmiScore } from '../../../src/modules/stock-meta/domain/pure/wcmi-scoring.js';
import type {
  LocalStockMetaWriterService,
  StockMetricsRow,
} from '../../../src/modules/stock-meta/local-stock-meta-writer.service.js';
import type { StockMetaService } from '../../../src/modules/stock-meta/stock-meta.service.js';
import type { StockMetricsComputeService } from '../../../src/modules/stock-meta/stock-metrics-compute.service.js';
import { StockMetricsBackfillService } from '../../../src/modules/stock-meta/stock-metrics-backfill.service.js';

function snap(code: string): StockSnapshotDto {
  return {
    meta: {
      code,
      name: code,
      name_pinyin: code,
      industries: '银行',
      list_date: '2001-01-01',
      float_pct: '1',
      updated_at: '2026-05-01T00:00:00+00:00',
      total_share: null,
      float_share: null,
      net_assets: null,
      net_assets_period: null,
      quarterlies: [],
      financials_updated_at: null,
    },
    price: null,
    asof: null,
    derived: {
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
    },
    returns: {
      ret_1d: null,
      ret_5d: null,
      ret_10d: null,
      ret_20d: null,
      ret_90d: null,
      ret_250d: null,
    },
    dde: null,
  };
}

/** Synthesise an N-bar trending kline series. Each step multiplies
 *  the previous close by `daily`; OHLC are all flat at `close` so
 *  there's no wick contribution. */
function trendingBars(n: number, daily: number, start = 100): KlineBar[] {
  const out: KlineBar[] = [];
  let c = start;
  const baseDate = new Date('2026-01-01T00:00:00Z').getTime();
  for (let i = 0; i < n; i += 1) {
    if (i > 0) c *= daily;
    const d = new Date(baseDate + i * 86_400_000).toISOString().slice(0, 10);
    out.push({
      date: d,
      open: c,
      high: c,
      low: c,
      close: c,
      volume: 0,
      turnover: 0,
      turnoverRate: 0,
      ma5: null,
      ma10: null,
      ma20: null,
      ma60: null,
    });
  }
  return out;
}

interface FakeBundle {
  readonly service: StockMetricsBackfillService;
  readonly upserted: StockMetricsRow[][];
  readonly seenScores: Array<{ code: string; score: WcmiScore | null }>;
}

function makeFakes(opts: {
  readonly snapshots: readonly StockSnapshotDto[];
  readonly klineByCode: Record<string, readonly KlineBar[]>;
}): FakeBundle {
  const upserted: StockMetricsRow[][] = [];
  const seenScores: Array<{ code: string; score: WcmiScore | null }> = [];
  const meta = { snapshotAll: async () => opts.snapshots } as unknown as StockMetaService;
  const kline = {
    lastNBulk: async (codes: readonly string[]) => {
      const out: Record<string, readonly KlineBar[]> = {};
      const codeSet = new Set(codes);
      for (const c of Object.keys(opts.klineByCode)) {
        if (codeSet.has(c)) out[c] = opts.klineByCode[c]!;
      }
      return out;
    },
  } as unknown as KlineReaderService;
  const compute = {
    toRowWithWcmi: (m: StockMetaDto, _bars: readonly KlineBar[], score: WcmiScore | null) => {
      seenScores.push({ code: m.code, score });
      const row: StockMetricsRow = {
        code: m.code,
        asof: '2026-05-15',
        metricsPrice: null,
        ret_1d: null,
        ret_5d: null,
        ret_10d: null,
        ret_20d: null,
        ret_90d: null,
        ret_250d: null,
        mkt_cap: null,
        float_mkt_cap: null,
        pe_ttm: null,
        pe_dynamic: null,
        pb: null,
        peg: null,
        gross_margin_ttm: null,
        wcmi: score === null ? null : score.composite.toString(),
        wcmi_rhythm: null,
        wcmi_ma_support: null,
        wcmi_up_wave: null,
        wcmi_yang_dom: null,
        wcmi_shadow_clean: null,
        wcmi_stage_gain: null,
        wcmi_crash_avoid: null, wcmi_recent_strength: null,
      };
      return row;
    },
  } as unknown as StockMetricsComputeService;
  const writer = {
    upsertMetrics: async (rows: readonly StockMetricsRow[]) => {
      upserted.push([...rows]);
    },
  } as unknown as LocalStockMetaWriterService;
  const service = new StockMetricsBackfillService(meta, kline, compute, writer);
  return { service, upserted, seenScores };
}

describe('StockMetricsBackfillService.runAll (batch wcmi scoring)', () => {
  it('writes one row per code that has kline; codes without bars are skipped', async () => {
    const { service, upserted } = makeFakes({
      snapshots: [snap('strong'), snap('weak'), snap('nokline')],
      klineByCode: {
        strong: trendingBars(91, 1.02),
        weak: trendingBars(91, 1.001),
        // 'nokline' has no entry → skipped
      },
    });
    const result = await service.runAll('tr-batch');
    expect(result.scanned).toBe(3);
    expect(result.projected).toBe(2);
    expect(upserted).toHaveLength(1);
    expect(upserted[0]!.map((r) => r.code).sort()).toEqual(['strong', 'weak']);
  });

  it('emits a higher wcmi for the strong-trend code than the weak one', async () => {
    const { service, seenScores } = makeFakes({
      snapshots: [snap('strong'), snap('weak')],
      klineByCode: {
        strong: trendingBars(91, 1.02),
        weak: trendingBars(91, 1.001),
      },
    });
    await service.runAll('tr-rank');
    const strong = seenScores.find((s) => s.code === 'strong')!.score;
    const weak = seenScores.find((s) => s.code === 'weak')!.score;
    expect(strong).not.toBeNull();
    expect(weak).not.toBeNull();
    expect(strong!.composite).toBeGreaterThan(weak!.composite);
  });

  it('gate-failed codes get wcmi = null but still receive a snapshot row', async () => {
    const { service, seenScores } = makeFakes({
      snapshots: [snap('up'), snap('down')],
      klineByCode: {
        up: trendingBars(91, 1.005),
        // Downward series: ret_10d strictly negative → gate fails → wcmi null
        down: trendingBars(91, 0.99),
      },
    });
    await service.runAll('tr-gate');
    const down = seenScores.find((s) => s.code === 'down')!;
    expect(down.score).toBeNull();
  });

  it('no-ops cleanly when the universe is empty', async () => {
    const { service, upserted } = makeFakes({ snapshots: [], klineByCode: {} });
    const result = await service.runAll('tr-empty');
    expect(result).toEqual({ scanned: 0, projected: 0 });
    expect(upserted).toEqual([]);
  });

  it('`run()` is a backwards-compat shim that delegates to runAll', async () => {
    const { service, upserted } = makeFakes({
      snapshots: [snap('one')],
      klineByCode: { one: trendingBars(91, 1.01) },
    });
    const result = await service.run('tr-shim');
    expect(result.projected).toBe(1);
    expect(upserted).toHaveLength(1);
  });
});
