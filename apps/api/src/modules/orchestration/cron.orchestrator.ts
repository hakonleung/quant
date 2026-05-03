/**
 * Cron orchestrator (`docs/modules/09-update-orchestration.md` §3).
 *
 * Runs once on bootstrap and every 60 minutes thereafter. Each tick asks
 * the inspector for incomplete-meta and stale-kline codes, then bulk-
 * enqueues onto the two queues. Read-time controllers can also enqueue
 * the same job ids; the queue's dedup keeps duplicates out.
 *
 * Note: the design doc names BullMQ + `@nestjs/schedule`; v1 uses an
 * in-process queue + `setInterval` because Redis is not part of the dev
 * baseline. Same semantics, smaller footprint — see
 * `domain/in-memory-queue.ts`.
 */

import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { newTraceId } from '@quant/shared';
import { CacheInspector } from './cache-inspector.js';
import { KLINE_QUEUE, META_QUEUE } from './flight.token.js';
import type { InMemoryQueue } from './domain/in-memory-queue.js';
import type { KlineJob, MetaJob } from './domain/types.js';

const SCAN_INTERVAL_MS = 60 * 60_000; // 60 minutes

@Injectable()
export class CronOrchestrator implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CronOrchestrator.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(META_QUEUE) private readonly metaQueue: InMemoryQueue<MetaJob>,
    @Inject(KLINE_QUEUE) private readonly klineQueue: InMemoryQueue<KlineJob>,
    @Inject(CacheInspector) private readonly inspector: CacheInspector,
  ) {}

  onModuleInit(): void {
    setImmediate(() => {
      void this.scan().catch((err: unknown) => {
        this.logger.error(
          `initial cron scan failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });
    this.timer = setInterval(() => {
      void this.scan().catch((err: unknown) => {
        this.logger.error(
          `cron scan failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, SCAN_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  async scan(): Promise<void> {
    const traceId = newTraceId();
    const t0 = Date.now();
    let metaEnqueued = 0;
    let klineEnqueued = 0;
    try {
      const [incomplete, stale] = await Promise.all([
        this.inspector.findIncompleteMeta(traceId),
        this.inspector.findStaleKline(traceId),
      ]);
      metaEnqueued = this.metaQueue.addBulk(
        incomplete.map((code) => ({
          data: { kind: 'enrich' as const, code, traceId },
          options: { id: `enrich:${code}` },
        })),
      );
      klineEnqueued = this.klineQueue.addBulk(
        stale.map((code) => ({
          data: { kind: 'sync' as const, code, traceId },
          options: { id: `sync:${code}` },
        })),
      );
    } catch (err) {
      this.logger.error(
        `inspector failed traceId=${traceId} err=${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    this.logger.log(
      `cron_scan_done traceId=${traceId} meta_enqueued=${String(metaEnqueued)} kline_enqueued=${String(klineEnqueued)} elapsedMs=${String(Date.now() - t0)}`,
    );
  }
}
