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

/**
 * gRPC ECONNREFUSED on the Flight port surfaces with status `14` and
 * a message containing `connect ECONNREFUSED`. We match on substrings
 * to stay decoupled from `@grpc/grpc-js` internals.
 */
function isPyFlightDown(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('ECONNREFUSED') ||
    msg.includes('UNAVAILABLE') ||
    msg.includes('No connection established')
  );
}

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
        this.logScanFailure('initial', err);
      });
    });
    this.timer = setInterval(() => {
      void this.scan().catch((err: unknown) => {
        this.logScanFailure('periodic', err);
      });
    }, SCAN_INTERVAL_MS);
  }

  private logScanFailure(phase: 'initial' | 'periodic', err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    if (isPyFlightDown(err)) {
      this.logger.warn(`${phase} cron scan skipped — py flight unreachable`);
    } else {
      this.logger.error(`${phase} cron scan failed: ${msg}`);
    }
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
      const msg = err instanceof Error ? err.message : String(err);
      // ECONNREFUSED on the Flight port is a benign dev-time signal —
      // it means the Python service isn't up yet (or has been stopped
      // for maintenance). Log at WARN with an explicit hint, not ERROR,
      // so the gateway log stays readable when py is intentionally off.
      if (isPyFlightDown(err)) {
        this.logger.warn(
          `inspector skipped — py flight unreachable (port 8815). traceId=${traceId}`,
        );
      } else {
        this.logger.error(`inspector failed traceId=${traceId} err=${msg}`);
      }
      return;
    }
    this.logger.log(
      `cron_scan_done traceId=${traceId} meta_enqueued=${String(metaEnqueued)} kline_enqueued=${String(klineEnqueued)} elapsedMs=${String(Date.now() - t0)}`,
    );
  }
}
