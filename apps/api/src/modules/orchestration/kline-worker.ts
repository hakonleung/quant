/**
 * K-line worker (`docs/modules/09-update-orchestration.md` §6.2).
 *
 * Processes a `kline_pkg` envelope as a single atomic unit:
 *   1. `sync_kline_for_code` — pull fresh bars and append to local
 *      parquet via {@link KlineWriterService}.
 *   2. `upsert_stock_metrics_for_code` — refresh the persisted
 *      `ret_*` / ma block on `stock_meta` for the same code. Best-effort
 *      relative to step (1): a projection failure does NOT mark the job
 *      failed, because the snapshot handler falls back to on-demand
 *      computation. Failure of step (1) bubbles to the queue, which
 *      applies retry / pool-backoff policy.
 *
 * Token-bucket rate limiting + the legacy 1-min circuit-breaker have
 * moved to the queue engine's `poolBackoff` config in
 * `OrchestrationModule`.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { FlightClient } from '../../adapters/flight/flight-client.js';
import { arrowTableToKlineRows, readSyncKlineReport } from '../kline/domain/arrow-mapper.js';
import { KlineWriterService } from '../kline/kline-writer.service.js';
import { ORCH_FLIGHT_CLIENT } from './flight.token.js';
import type { JobEnvelope, JobProcessor, KlineJob, ReQueue } from './domain/types.js';

@Injectable()
export class KlineWorker implements JobProcessor<KlineJob> {
  private readonly logger = new Logger(KlineWorker.name);

  constructor(
    @Inject(ORCH_FLIGHT_CLIENT) private readonly flight: FlightClient,
    @Inject(KlineWriterService) private readonly writer: KlineWriterService,
  ) {}

  async process(job: JobEnvelope<KlineJob>, _queue: ReQueue<KlineJob>): Promise<void> {
    const { code, traceId } = job.data;
    const result = await this.flight.doGet(
      'sync_kline_for_code',
      { code, trace_id: traceId },
      { traceId, deadlineMs: 30_000 },
    );
    const report = readSyncKlineReport(result.value);
    const rows = arrowTableToKlineRows(result.value);
    if (rows.length > 0) {
      await this.writer.appendBars(rows);
    }
    try {
      await this.flight.doGet(
        'upsert_stock_metrics_for_code',
        { code, trace_id: traceId },
        { traceId, deadlineMs: 10_000 },
      );
    } catch (projErr) {
      this.logger.warn(
        `kline_metrics_projection_failed code=${code} trace_id=${traceId} err=${projErr instanceof Error ? projErr.message : String(projErr)}`,
      );
    }
    this.logger.log(
      `kline_pkg_done code=${code} mode=${report.mode} fetched=${String(report.fetchedBars)} written=${String(rows.length)} trace_id=${traceId}`,
    );
  }
}
