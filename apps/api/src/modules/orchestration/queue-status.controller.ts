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

import { Controller, Get, HttpCode, HttpStatus, Inject, Post, Query } from '@nestjs/common';
import { ScanKindSchema, type QueueSnapshot, type ScanAccepted, type ScanKind } from '@quant/shared';

import { ZodValidationPipe } from '../../common/zod-pipe.js';

import { CronOrchestrator } from './cron.orchestrator.js';
import { QueueBroadcaster } from './queue.broadcaster.js';

@Controller('orchestration')
export class QueueStatusController {
  constructor(
    @Inject(QueueBroadcaster) private readonly broadcaster: QueueBroadcaster,
    @Inject(CronOrchestrator) private readonly cron: CronOrchestrator,
  ) {}

  @Get('queue')
  snapshot(): QueueSnapshot {
    return this.broadcaster.makeSnapshot();
  }

  /**
   * Fire-and-forget manual trigger for the meta / kline / all scan.
   * Returns 202 Accepted with a {@link ScanAccepted} envelope as soon
   * as the scan is kicked off — the client tracks progress via the
   * socket `queue.snapshot` topic instead of holding the request open.
   */
  @Post('scan')
  @HttpCode(HttpStatus.ACCEPTED)
  manualScan(
    @Query('kind', new ZodValidationPipe(ScanKindSchema.default('all')))
    kind: ScanKind,
  ): ScanAccepted {
    return this.cron.fireScan(kind);
  }
}
