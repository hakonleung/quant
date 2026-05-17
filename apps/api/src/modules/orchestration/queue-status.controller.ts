/**
 * Live task-queue telemetry.
 *
 *   GET /api/orchestration/queue   → QueueSnapshot (one-shot JSON)
 *   POST /api/orchestration/scan   → ScanAccepted (manual trigger)
 *
 * Realtime updates moved off SSE onto the unified Socket.IO bus
 * (`queue.snapshot` topic, see `QueueBroadcaster`). Clients that want
 * the live stream subscribe via the socket; this controller only serves
 * the one-shot snapshot used for initial render and degraded fallback.
 */

import { Controller, Get, HttpCode, HttpStatus, Inject, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { type QueueSnapshot, type ScanAccepted } from '@quant/shared';

import type { RequestWithTraceId } from '../../common/trace.middleware.js';
import { StockMetricsBackfillService } from '../stock-meta/stock-metrics-backfill.service.js';
import { CronOrchestrator } from './cron.orchestrator.js';
import { QueueBroadcaster } from './queue.broadcaster.js';

@Controller('orchestration')
export class QueueStatusController {
  constructor(
    @Inject(QueueBroadcaster) private readonly broadcaster: QueueBroadcaster,
    @Inject(CronOrchestrator) private readonly cron: CronOrchestrator,
    @Inject(StockMetricsBackfillService)
    private readonly metricsBackfill: StockMetricsBackfillService,
  ) {}

  @Get('queue')
  snapshot(): QueueSnapshot {
    return this.broadcaster.makeSnapshot();
  }

  /**
   * Fire-and-forget manual trigger for the unified scan (meta + kline
   * + settlement tail). Returns 202 Accepted with a {@link ScanAccepted}
   * envelope as soon as the scan is kicked off — the client tracks
   * progress via the socket `queue.snapshot` topic instead of holding
   * the request open.
   */
  @Post('scan')
  @HttpCode(HttpStatus.ACCEPTED)
  manualScan(): ScanAccepted {
    return this.cron.fireScan();
  }

  /**
   * One-shot full-universe metrics projection. Recomputes the persisted
   * `metrics_*` block (incl. wcmi) for every code that has any local
   * kline rows — ignores the asof watermark used by the daily cron.
   * Synchronous (awaits projection); use sparingly.
   */
  @Post('backfill-metrics')
  async backfillMetrics(
    @Req() req: Request,
  ): Promise<{ readonly scanned: number; readonly projected: number }> {
    const tid = (req as Partial<RequestWithTraceId>).traceId ?? '';
    return this.metricsBackfill.runAll(tid);
  }
}
