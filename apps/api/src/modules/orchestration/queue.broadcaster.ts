/**
 * Periodically pushes the orchestration `QueueSnapshot` onto the
 * realtime socket bus (`queue.snapshot` topic). Replaces the legacy
 * `GET /api/orchestration/queue/stream` SSE endpoint at 1Hz.
 */

import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { QueueSnapshot, QueueSnapshotEntry } from '@quant/shared';

import { SocketBus } from '../socket/socket-bus.service.js';
import { CronOrchestrator } from './cron.orchestrator.js';
import type { InMemoryQueue } from './domain/in-memory-queue.js';
import type { KlineJob, MetaJob } from './domain/types.js';
import { KLINE_QUEUE, META_QUEUE } from './flight.token.js';

const TICK_MS = 1_000;

@Injectable()
export class QueueBroadcaster implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueBroadcaster.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(META_QUEUE) private readonly meta: InMemoryQueue<MetaJob>,
    @Inject(KLINE_QUEUE) private readonly kline: InMemoryQueue<KlineJob>,
    @Inject(CronOrchestrator) private readonly cron: CronOrchestrator,
    @Inject(SocketBus) private readonly bus: SocketBus,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      try {
        this.bus.emit('queue.snapshot', this.makeSnapshot());
      } catch (err) {
        this.logger.warn(`queue_broadcast_failed err=${String(err)}`);
      }
    }, TICK_MS);
    this.logger.log(`queue broadcaster armed — tick=${String(TICK_MS)}ms`);
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Same shape as the old SSE handler — kept here so the snapshot
   *  endpoint can reuse it. */
  makeSnapshot(): QueueSnapshot {
    return {
      ts: new Date().toISOString(),
      queues: [entry(this.meta), entry(this.kline)],
      activeScans: [...this.cron.activeScans()],
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
