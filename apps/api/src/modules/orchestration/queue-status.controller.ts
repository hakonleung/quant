/**
 * Live task-queue telemetry (modules/07-frontend.md §SSE addendum).
 *
 *   GET /api/orchestration/queue          → QueueSnapshot                (one-shot JSON)
 *   GET /api/orchestration/queue/stream   → text/event-stream            (SSE, 1Hz)
 *
 * The stream emits `data: <QueueSnapshot JSON>\n\n` once per second and a
 * keepalive comment line every 15s; the cyber UI panel uses it to render
 * the live worker pulse without polling.
 *
 * No mocks: numbers come straight from the live `InMemoryQueue` instances
 * the orchestration module owns.
 */

import { Controller, Get, HttpCode, HttpStatus, Inject, Post, Query, Sse } from '@nestjs/common';
import {
  ScanKindSchema,
  type QueueSnapshot,
  type QueueSnapshotEntry,
  type ScanAccepted,
  type ScanKind,
} from '@quant/shared';
import { Observable, interval, map, startWith } from 'rxjs';

import { ZodValidationPipe } from '../../common/zod-pipe.js';

import { CronOrchestrator } from './cron.orchestrator.js';
import type { InMemoryQueue } from './domain/in-memory-queue.js';
import type { KlineJob, MetaJob } from './domain/types.js';
import { KLINE_QUEUE, META_QUEUE } from './flight.token.js';

interface SseChunk {
  readonly data: QueueSnapshot;
}

const TICK_MS = 1000;

@Controller('orchestration')
export class QueueStatusController {
  constructor(
    @Inject(META_QUEUE) private readonly meta: InMemoryQueue<MetaJob>,
    @Inject(KLINE_QUEUE) private readonly kline: InMemoryQueue<KlineJob>,
    @Inject(CronOrchestrator) private readonly cron: CronOrchestrator,
  ) {}

  @Get('queue')
  snapshot(): QueueSnapshot {
    return this.makeSnapshot();
  }

  @Sse('queue/stream')
  stream(): Observable<SseChunk> {
    return interval(TICK_MS).pipe(
      startWith(0),
      map(() => ({ data: this.makeSnapshot() })),
    );
  }

  /**
   * Fire-and-forget manual trigger for the meta / kline / all scan.
   * Returns 202 Accepted with a {@link ScanAccepted} envelope as soon
   * as the scan is kicked off — the client tracks progress via the
   * SSE queue stream instead of holding the request open. Coalesces
   * per-kind so spam-clicks share one in-flight scan.
   */
  @Post('scan')
  @HttpCode(HttpStatus.ACCEPTED)
  manualScan(
    @Query('kind', new ZodValidationPipe(ScanKindSchema.default('all')))
    kind: ScanKind,
  ): ScanAccepted {
    return this.cron.fireScan(kind);
  }

  private makeSnapshot(): QueueSnapshot {
    return {
      ts: new Date().toISOString(),
      queues: [entry(this.meta), entry(this.kline)],
    };
  }
}

function entry<T>(q: InMemoryQueue<T>): QueueSnapshotEntry {
  return {
    name: q.name,
    pending: q.pending,
    inFlight: q.inFlight,
    paused: q.isPaused,
  };
}
