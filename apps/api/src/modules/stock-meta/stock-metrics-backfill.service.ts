/**
 * Cron-side backfill for the ``metrics_*`` block on ``stock_metas.parquet``.
 *
 * The per-code projection runs inside the kline worker after a kline
 * sync (see ``kline-worker.ts``). Codes whose kline is already caught
 * up are not enqueued by ``CacheInspector.findStaleKline``, so codes
 * that were last synced before the projection step was wired up never
 * got their metrics back-filled. This service scans the local meta +
 * kline state and runs the in-process projector for codes where the
 * snapshot watermark trails the local kline watermark — no Flight hop,
 * no Python.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';

import { KlineReaderService } from '../kline/kline-reader.service.js';
import { LocalStockMetaWriterService, type StockMetricsRow } from './local-stock-meta-writer.service.js';
import { StockMetaService } from './stock-meta.service.js';
import { StockMetricsComputeService } from './stock-metrics-compute.service.js';

const PROJECT_BATCH_SIZE = 200;

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

  async run(traceId: string): Promise<{ readonly scanned: number; readonly projected: number }> {
    const stale = await this.findStaleCodes(traceId);
    return this.projectCodes(stale, traceId, 'stale');
  }

  /**
   * One-shot full-universe projection — ignores the asof watermark.
   * Use to seed a newly-added metric column (e.g. wcmi) on every code
   * whose kline is present, without waiting for the daily cron to
   * happen to flag each one stale.
   */
  async runAll(traceId: string): Promise<{ readonly scanned: number; readonly projected: number }> {
    const snapshots = await this.meta.snapshotAll(traceId);
    const codes = snapshots.map((s) => s.meta.code);
    const watermarks = await this.kline.lastTradeDates(codes);
    const targets = codes.filter((c) => watermarks.has(c));
    return this.projectCodes(targets, traceId, 'full');
  }

  private async projectCodes(
    codes: readonly string[],
    traceId: string,
    mode: 'stale' | 'full',
  ): Promise<{ readonly scanned: number; readonly projected: number }> {
    if (codes.length === 0) {
      this.logger.debug(`metrics_backfill_skip mode=${mode} scanned=0 traceId=${traceId}`);
      return { scanned: 0, projected: 0 };
    }
    let projected = 0;
    for (let i = 0; i < codes.length; i += PROJECT_BATCH_SIZE) {
      const slice = codes.slice(i, i + PROJECT_BATCH_SIZE);
      const rows: StockMetricsRow[] = [];
      for (const code of slice) {
        try {
          const row = await this.compute.computeForCode(code);
          if (row !== null) rows.push(row);
        } catch (err) {
          this.logger.warn(
            `metrics_backfill_compute_failed code=${code} traceId=${traceId} err=${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (rows.length > 0) {
        await this.writer.upsertMetrics(rows);
        projected += rows.length;
      }
    }
    this.logger.log(
      `metrics_backfill_done mode=${mode} scanned=${String(codes.length)} projected=${String(projected)} traceId=${traceId}`,
    );
    return { scanned: codes.length, projected };
  }

  private async findStaleCodes(traceId: string): Promise<readonly string[]> {
    const snapshots = await this.meta.snapshotAll(traceId);
    if (snapshots.length === 0) return [];
    const codes = snapshots.map((s) => s.meta.code);
    const watermarks = await this.kline.lastTradeDates(codes);
    const stale: string[] = [];
    for (const snap of snapshots) {
      const code = snap.meta.code;
      const lastTs = watermarks.get(code);
      if (lastTs === undefined) continue; // no kline → nothing to project against
      const klineLast = lastTs.toISOString().slice(0, 10);
      const asof = snap.asof;
      if (asof === null || asof < klineLast) stale.push(code);
    }
    return stale;
  }
}
