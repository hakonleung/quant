/**
 * Cron orchestrator (`docs/modules/09-update-orchestration.md` §3).
 *
 * Schedule:
 *   - one scan daily at 15:15 Asia/Shanghai (post-close + akshare flush)
 *   - manual scans via {@link triggerScan} (wired to a Nest endpoint)
 *
 * No scan on bootstrap — cold-starts during a trading session would
 * fan out a full-universe enqueue every restart. Use the manual
 * trigger if a scan is needed before the next 15:15.
 *
 * Each scan asks the inspector for incomplete-meta and stale-kline codes,
 * then bulk-enqueues onto the two queues. Read-time controllers can also
 * enqueue the same job ids; the queue's dedup keeps duplicates out.
 *
 * No `@nestjs/schedule` dep on purpose — daily firing is computed against
 * the China-market wall clock with a single `setTimeout`, and re-armed
 * after each scan. Concurrent scans are coalesced behind one in-flight
 * promise so a manual click during an autoscan doesn't double-fire.
 */

import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { newTraceId, type ScanResult } from '@quant/shared';
import { CacheInspector } from './cache-inspector.js';
import { KLINE_QUEUE, META_QUEUE } from './flight.token.js';
import type { InMemoryQueue } from './domain/in-memory-queue.js';
import type { KlineJob, MetaJob } from './domain/types.js';

const BJT_HOUR = 15;
const BJT_MINUTE = 15;
const BJT_OFFSET_MS = 8 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

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

/**
 * Milliseconds from `now` until the next 15:15 Asia/Shanghai. If we're
 * already past today's 15:15 (BJT), returns the delay to tomorrow's.
 */
export function msUntilNextBjt1515(now: number = Date.now()): number {
  // Convert "now" into a BJT-clock representation by shifting by +08:00,
  // then read the wall-clock fields off a UTC date built from that
  // shifted instant. This avoids relying on the host TZ.
  const bjt = new Date(now + BJT_OFFSET_MS);
  const y = bjt.getUTCFullYear();
  const m = bjt.getUTCMonth();
  const d = bjt.getUTCDate();
  const targetUtcMs = Date.UTC(y, m, d, BJT_HOUR, BJT_MINUTE) - BJT_OFFSET_MS;
  const delta = targetUtcMs - now;
  return delta <= 0 ? delta + DAY_MS : delta;
}

@Injectable()
export class CronOrchestrator implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CronOrchestrator.name);
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<ScanResult> | null = null;
  private destroyed = false;

  constructor(
    @Inject(META_QUEUE) private readonly metaQueue: InMemoryQueue<MetaJob>,
    @Inject(KLINE_QUEUE) private readonly klineQueue: InMemoryQueue<KlineJob>,
    @Inject(CacheInspector) private readonly inspector: CacheInspector,
  ) {}

  onModuleInit(): void {
    this.scheduleNextDaily();
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * Run a scan, coalescing with any in-flight one. Safe to invoke from
   * the daily timer, the bootstrap hook, or the manual-trigger HTTP
   * endpoint without risking parallel inspector calls.
   */
  triggerScan(): Promise<ScanResult> {
    if (this.inFlight !== null) return this.inFlight;
    const p = this.scan().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = p;
    return p;
  }

  private scheduleNextDaily(): void {
    if (this.destroyed) return;
    const delay = msUntilNextBjt1515();
    this.logger.log(`next_daily_scan_in_ms=${String(delay)}`);
    this.timer = setTimeout(() => {
      void this.triggerScan()
        .catch((err: unknown) => {
          this.logScanFailure('daily', err);
        })
        .finally(() => {
          this.scheduleNextDaily();
        });
    }, delay);
  }

  private async scan(): Promise<ScanResult> {
    const traceId = newTraceId();
    const startedAt = new Date().toISOString();
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
      return {
        traceId,
        startedAt,
        elapsedMs: Date.now() - t0,
        metaEnqueued: 0,
        klineEnqueued: 0,
      };
    }
    const elapsedMs = Date.now() - t0;
    this.logger.log(
      `cron_scan_done traceId=${traceId} meta_enqueued=${String(metaEnqueued)} kline_enqueued=${String(klineEnqueued)} elapsedMs=${String(elapsedMs)}`,
    );
    return { traceId, startedAt, elapsedMs, metaEnqueued, klineEnqueued };
  }

  private logScanFailure(phase: 'daily' | 'manual', err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    if (isPyFlightDown(err)) {
      this.logger.warn(`${phase} cron scan skipped — py flight unreachable`);
    } else {
      this.logger.error(`${phase} cron scan failed: ${msg}`);
    }
  }
}
