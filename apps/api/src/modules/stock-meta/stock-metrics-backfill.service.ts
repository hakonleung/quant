/**
 * Batch projector for `data/stock_metas.parquet`'s `metrics_*` block.
 *
 * The `wcmi` column is **cross-sectional**: a code's score depends on
 * where its raw features (returns + form counts + drawdown …) sit
 * inside the percentile table of the whole universe. That makes per-
 * code projection unsuitable — the kline worker still updates returns
 * / derived for staled codes, but it leaves `wcmi = null`. This
 * service runs after each cron settle and re-scores every code in one
 * batch.
 *
 *   Phase 1  read all `(meta, bars)` pairs via bulk APIs
 *   Phase 2  extract raw features per code (in-process pure code)
 *   Phase 3  scoreUniverse() — percentile tables + module blend
 *   Phase 4  emit StockMetricsRow per code, upsert in slices
 *
 * Codes whose history is too short or whose gate fails get
 * `wcmi = null`; they still get their returns/derived block written
 * via `toRowWithWcmi` so the rest of the snapshot stays fresh.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { KlineBar, StockMetaDto } from '@quant/shared';

import { KlineReaderService } from '../kline/kline-reader.service.js';
import { LocalStockMetaWriterService, type StockMetricsRow } from './local-stock-meta-writer.service.js';
import { StockMetaService } from './stock-meta.service.js';
import { StockMetricsComputeService } from './stock-metrics-compute.service.js';
import {
  extractRawFeatures,
  scoreUniverse,
  type ScoringInput,
  type WcmiRawFeatures,
} from './domain/pure/wcmi-scoring.js';

/** Kline tail window — must cover the longest scoring need (90d
 *  returns) plus the 50d lookback for S_exp. 280 ≈ 13 calendar months
 *  of trading days, generous safety margin. */
const TAIL_BARS = 280;
/** Per-batch parquet upsert size (cap on memory + SQL footprint). */
const UPSERT_BATCH_SIZE = 500;

@Injectable()
export class StockMetricsBackfillService {
  private readonly logger = new Logger(StockMetricsBackfillService.name);

  constructor(
    @Inject(StockMetaService) private readonly meta: StockMetaService,
    @Inject(KlineReaderService) private readonly kline: KlineReaderService,
    @Inject(StockMetricsComputeService)
    private readonly compute: StockMetricsComputeService,
    @Inject(LocalStockMetaWriterService)
    private readonly writer: LocalStockMetaWriterService,
  ) {}

  /** Backwards-compat shim — the cron used to call this. Now there's
   *  no "stale only" mode; wcmi requires the full universe, so just
   *  delegate to {@link runAll}. */
  async run(traceId: string): Promise<{ readonly scanned: number; readonly projected: number }> {
    return this.runAll(traceId);
  }

  /**
   * Full-universe batch run. Returns counts for the cron / admin
   * endpoint's response body.
   */
  async runAll(traceId: string): Promise<{ readonly scanned: number; readonly projected: number }> {
    // ── Phase 1: bulk read meta + kline ─────────────────────────
    const snapshots = await this.meta.snapshotAll(traceId);
    if (snapshots.length === 0) {
      this.logger.debug(`metrics_backfill_skip scanned=0 traceId=${traceId}`);
      return { scanned: 0, projected: 0 };
    }
    const metaByCode = new Map<string, StockMetaDto>();
    for (const snap of snapshots) metaByCode.set(snap.meta.code, snap.meta);
    const codes = Array.from(metaByCode.keys());
    const klineByCode = await this.kline.lastNBulk(codes, TAIL_BARS);

    // ── Phase 2: extract raw features ───────────────────────────
    interface CodeContext {
      readonly code: string;
      readonly meta: StockMetaDto;
      readonly bars: readonly KlineBar[];
      readonly raw: WcmiRawFeatures | null;
    }
    const contexts: CodeContext[] = [];
    const rankInputs: ScoringInput[] = [];
    for (const code of codes) {
      const meta = metaByCode.get(code)!;
      const bars = klineByCode[code] ?? [];
      if (bars.length === 0) {
        contexts.push({ code, meta, bars, raw: null });
        continue;
      }
      const raw = extractRawFeatures(bars.map(toBarLike));
      contexts.push({ code, meta, bars, raw });
      if (raw !== null) rankInputs.push({ code, raw });
    }

    // ── Phase 3: universe-wide scoring ──────────────────────────
    const scores = scoreUniverse(rankInputs);
    const scoredCount = Array.from(scores.values()).filter((v) => v !== null).length;

    // ── Phase 4: build rows + upsert in slices ──────────────────
    const rows: StockMetricsRow[] = [];
    for (const ctx of contexts) {
      if (ctx.bars.length === 0) continue;
      const score = scores.get(ctx.code) ?? null;
      rows.push(this.compute.toRowWithWcmi(ctx.meta, ctx.bars, score));
    }
    let projected = 0;
    for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
      const slice = rows.slice(i, i + UPSERT_BATCH_SIZE);
      await this.writer.upsertMetrics(slice);
      projected += slice.length;
    }
    this.logger.log(
      `metrics_backfill_done scanned=${String(codes.length)} projected=${String(projected)} scored=${String(scoredCount)} traceId=${traceId}`,
    );
    return { scanned: codes.length, projected };
  }
}

function toBarLike(bar: KlineBar): {
  trade_date: string;
  open_qfq: number;
  high_qfq: number;
  low_qfq: number;
  close_qfq: number;
  volume: number;
  turnover: number;
} {
  return {
    trade_date: bar.date,
    open_qfq: bar.open,
    high_qfq: bar.high,
    low_qfq: bar.low,
    close_qfq: bar.close,
    volume: bar.volume,
    turnover: bar.turnover,
  };
}
