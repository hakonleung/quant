/**
 * In-process replacement for Python's ``compute_stock_metrics_for_code``
 * Flight op.
 *
 * Reads the meta + trailing kline window via the local NestJS adapters
 * (no Flight hop), projects them through the pure
 * {@link computeMetrics}, and emits a {@link StockMetricsRow} that
 * {@link LocalStockMetaWriterService.upsertMetrics} can write straight
 * into ``stock_metas.parquet``.
 *
 * Window size: the longest return window is ``ret_250d`` so we need at
 * least 251 bars; ``TAIL_BARS`` keeps a comfortable margin (matches the
 * "400 calendar days" the Py projector used).
 */

import { Inject, Injectable } from '@nestjs/common';
import type { KlineBar, StockMetaDto } from '@quant/shared';

import { KlineReaderService } from '../kline/kline-reader.service.js';
import { computeMetrics, type BarLike, type StockMetrics } from './domain/pure/compute-metrics.js';
import type { Dec } from './domain/pure/decimal-config.js';
import type { WcmiScore } from './domain/pure/wcmi-scoring.js';
import { LocalStockMetaAdapter } from './local-stock-meta.adapter.js';
import type { StockMetricsRow } from './local-stock-meta-writer.service.js';

const TAIL_BARS = 280;

@Injectable()
export class StockMetricsComputeService {
  constructor(
    @Inject(LocalStockMetaAdapter) private readonly metaAdapter: LocalStockMetaAdapter,
    @Inject(KlineReaderService) private readonly klineReader: KlineReaderService,
  ) {}

  /**
   * Compute the persisted metrics block for one code.
   *
   * Returns ``null`` when the meta repo has no row for ``code`` — matches
   * the Py handler's silent-skip behaviour for the brief window between
   * a new listing and the next meta-sync cron tick.
   */
  async computeForCode(code: string): Promise<StockMetricsRow | null> {
    const meta = await this.metaAdapter.getOne(code);
    if (meta === null) return null;
    const bars = await this.klineReader.lastNForCode(code, TAIL_BARS);
    const metrics = computeMetrics(meta, bars.map(toBarLike));
    return toRow(metrics);
  }

  /**
   * Batch-side variant: produce a row using a pre-fetched `(meta,
   * bars)` pair and an externally-supplied `wcmi` score. The wcmi
   * column requires universe-wide percentile tables which only the
   * backfill orchestrator has — see `StockMetricsBackfillService`.
   */
  toRowWithWcmi(
    meta: StockMetaDto,
    bars: readonly KlineBar[],
    wcmiScore: WcmiScore | null,
  ): StockMetricsRow {
    const metrics = computeMetrics(meta, bars.map(toBarLike));
    const row = toRow(metrics);
    if (wcmiScore === null) return row;
    return {
      ...row,
      wcmi: formatWcmiScore(wcmiScore.composite),
      wcmi_rhythm: formatPct(wcmiScore.pct.rhythm),
      wcmi_ma_support: formatPct(wcmiScore.pct.maSupport),
      wcmi_up_wave: formatPct(wcmiScore.pct.upWaveSmoothness),
      wcmi_yang_dom: formatPct(wcmiScore.pct.yangDominance),
      wcmi_shadow_clean: formatPct(wcmiScore.pct.upperShadowClean),
      wcmi_stage_gain: formatPct(wcmiScore.pct.stageGain),
      wcmi_crash_avoid: formatPct(wcmiScore.pct.crashAvoidance),
    };
  }
}

/** Serialise a `[0, 1]` percentile rank as a percent string with two
 *  decimals (`"73.40"`). Plain `.toFixed(2)` is safe — `pct` is in
 *  `[0, 1]` so `pct * 100` cannot reach scientific-notation territory. */
function formatPct(pct: number): string {
  return (pct * 100).toFixed(2);
}

/**
 * Serialise a numeric wcmi score for the parquet column. Plain
 * `Number.toString()` switches to scientific notation when the
 * magnitude is below `~1e-6` (e.g. when module-level percentile
 * norms cancel out under float roundoff). The shared zod
 * `decimalStringOrNull` schema rejects that format and 500s the read
 * path. Fixing at the serialise boundary keeps the column shape
 * stable regardless of upstream float behaviour.
 */
function formatWcmiScore(score: number): string {
  // Two decimals is well past what the FE renders (toFixed(0)) but
  // keeps a tiny precision buffer for other consumers; either way it
  // is guaranteed to match `/^-?\d+(\.\d+)?$/`.
  return score.toFixed(2);
}

function toBarLike(bar: KlineBar): BarLike {
  return {
    trade_date: bar.date,
    open_qfq: bar.open,
    high_qfq: bar.high,
    low_qfq: bar.low,
    close_qfq: bar.close,
    volume: bar.volume,
    turnover: bar.turnover,
    ma5: bar.ma5,
    ma10: bar.ma10,
    ma20: bar.ma20,
    ma60: bar.ma60,
  };
}

function toRow(m: StockMetrics): StockMetricsRow {
  return {
    code: m.code,
    asof: m.asof,
    metricsPrice: decStr(m.price),
    ret_1d: decStr(m.ret_1d),
    ret_5d: decStr(m.ret_5d),
    ret_10d: decStr(m.ret_10d),
    ret_20d: decStr(m.ret_20d),
    ret_90d: decStr(m.ret_90d),
    ret_250d: decStr(m.ret_250d),
    mkt_cap: decStr(m.mkt_cap),
    float_mkt_cap: decStr(m.float_mkt_cap),
    pe_ttm: decStr(m.pe_ttm),
    pe_dynamic: decStr(m.pe_dynamic),
    pb: decStr(m.pb),
    peg: decStr(m.peg),
    gross_margin_ttm: decStr(m.gross_margin_ttm),
    wcmi: decStr(m.wcmi),
    wcmi_rhythm: decStr(m.wcmi_rhythm),
    wcmi_ma_support: decStr(m.wcmi_ma_support),
    wcmi_up_wave: decStr(m.wcmi_up_wave),
    wcmi_yang_dom: decStr(m.wcmi_yang_dom),
    wcmi_shadow_clean: decStr(m.wcmi_shadow_clean),
    wcmi_stage_gain: decStr(m.wcmi_stage_gain),
    wcmi_crash_avoid: decStr(m.wcmi_crash_avoid),
  };
}

function decStr(value: Dec | null): string | null {
  return value === null ? null : value.toString();
}
