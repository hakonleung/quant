/**
 * Cron orchestrator (`docs/modules/09-update-orchestration.md` §3).
 *
 * Schedule:
 *   - one scan daily at 16:00 Asia/Shanghai (post-close + akshare flush)
 *   - manual scans via {@link triggerScan} (wired to a Nest endpoint)
 *
 * Each scan asks the inspector for stale-kline + stale-meta codes, then
 * bulk-enqueues *package-shaped* jobs (one envelope per code) on the
 * meta and kline queues. Every envelope from the same scan carries the
 * same `batchId`; {@link BatchSettler} listens for terminal events with
 * that id to fire blacklist + dynamic-sectors recompute as the tail-off.
 *
 * The scan is monolithic: meta + kline always run together and blacklist
 * + dynamic sectors run in settlement. There is no per-kind selector
 * anymore — the cost split that used to motivate it disappeared once
 * settlement absorbed the blacklist refresh.
 *
 * No `@nestjs/schedule` dep on purpose — daily firing is computed
 * against the China-market wall clock with a single `setTimeout`, and
 * re-armed after each scan. Concurrent scans are coalesced behind one
 * in-flight promise so a manual click during an autoscan doesn't
 * double-fire.
 */

/* eslint-disable no-restricted-globals -- scheduler races the wall clock; Date use is the unit of work, not a hidden side-effect. */

import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ServerConfigCenter } from '@quant/config/server';
import { newTraceId, type ScanAccepted, type ScanResult } from '@quant/shared';
import { isPyFlightDown } from '../../adapters/flight/flight-errors.js';
import { BatchSettler } from './batch-settler.js';
import { CacheInspector } from './cache-inspector.js';
import { KLINE_QUEUE, META_QUEUE } from './flight.token.js';
import type { InMemoryQueue } from './domain/in-memory-queue.js';
import type { KlineJob, MetaJob } from './domain/types.js';

/**
 * Milliseconds from `now` until the next scheduled BJT hour. If we're
 * already past today's, returns the delay to tomorrow's. Reads the
 * target hour/minute + offsets from `ServerConfigCenter.orchestration.cron`
 * so tests can pin a different schedule via env.
 */
export function msUntilNextBjt1600(now: number = Date.now()): number {
  const cron = ServerConfigCenter.get().orchestration.cron;
  const bjt = new Date(now + cron.bjtOffsetMs);
  const y = bjt.getUTCFullYear();
  const m = bjt.getUTCMonth();
  const d = bjt.getUTCDate();
  const targetUtcMs = Date.UTC(y, m, d, cron.bjtHour, cron.bjtMinute) - cron.bjtOffsetMs;
  const delta = targetUtcMs - now;
  return delta <= 0 ? delta + cron.dayMs : delta;
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
    @Inject(BatchSettler) private readonly settler: BatchSettler,
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
   * Run a scan, coalescing with any in-flight one. Both queues + the
   * settlement tail are part of every scan.
   */
  triggerScan(traceId?: string): Promise<ScanResult> {
    if (this.inFlight !== null) return this.inFlight;
    const p = this.scan(traceId ?? newTraceId()).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = p;
    return p;
  }

  /** True while a scan is in flight (covers bulk RPC, enqueue, and settlement). */
  isScanning(): boolean {
    return this.inFlight !== null;
  }

  fireScan(): ScanAccepted {
    const startedAt = new Date().toISOString();
    const traceId = newTraceId();
    const wasInflight = this.inFlight !== null;
    this.logger.log(
      `manual_scan_fired traceId=${traceId} coalesced=${String(wasInflight)}`,
    );
    void this.triggerScan(traceId).catch((err: unknown) => {
      this.logScanFailure('manual', err);
    });
    return { traceId, startedAt, started: !wasInflight };
  }

  private scheduleNextDaily(): void {
    if (this.destroyed) return;
    const delay = msUntilNextBjt1600();
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

  private async scan(traceId: string): Promise<ScanResult> {
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const batchId = traceId;
    const result = await this.enqueueBatch(traceId, batchId);
    if (result === null) {
      return {
        traceId,
        startedAt,
        elapsedMs: Date.now() - t0,
        metaEnqueued: 0,
        klineEnqueued: 0,
      };
    }
    const [metaEnqueued, klineEnqueued] = result;
    this.settler.register({
      batchId,
      metaCount: metaEnqueued,
      klineCount: klineEnqueued,
      traceId,
    });
    const elapsedMs = Date.now() - t0;
    this.logger.log(
      `cron_scan_done traceId=${traceId} meta_enqueued=${String(metaEnqueued)} kline_enqueued=${String(klineEnqueued)} elapsedMs=${String(elapsedMs)}`,
    );
    return { traceId, startedAt, elapsedMs, metaEnqueued, klineEnqueued };
  }

  /** Returns `[metaEnqueued, klineEnqueued]` or `null` when the inspector
   *  itself failed (caller emits an empty `ScanResult`). */
  private async enqueueBatch(
    traceId: string,
    batchId: string,
  ): Promise<readonly [number, number] | null> {
    try {
      await this.inspector.syncBulkFinancials(traceId);
      const [meta, kline] = await Promise.all([
        this.scanMeta(traceId, batchId),
        this.scanKline(traceId, batchId),
      ]);
      return [meta, kline];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isPyFlightDown(err)) {
        this.logger.warn(`inspector skipped — py flight unreachable. traceId=${traceId}`);
      } else {
        this.logger.error(`inspector failed traceId=${traceId} err=${msg}`);
      }
      return null;
    }
  }

  private async scanMeta(traceId: string, batchId: string): Promise<number> {
    const items = await this.inspector.findMetaWork(traceId);
    return this.metaQueue.addBulk(
      items.map((it) => ({
        data: {
          kind: 'meta_pkg' as const,
          code: it.code,
          needBasic: it.needBasic,
          needFinancials: it.needFinancials,
          traceId,
          batchId,
        },
        options: { id: `meta:${batchId}:${it.code}` },
      })),
    );
  }

  private async scanKline(traceId: string, batchId: string): Promise<number> {
    const codes = await this.inspector.findStaleKline(traceId);
    return this.klineQueue.addBulk(
      codes.map((code) => ({
        data: {
          kind: 'kline_pkg' as const,
          code,
          traceId,
          batchId,
        },
        options: { id: `kline:${batchId}:${code}` },
      })),
    );
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
