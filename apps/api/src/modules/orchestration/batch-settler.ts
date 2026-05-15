/**
 * Batch settler — runs the daily tail-off when every job produced by a
 * single `CronOrchestrator.scan('all')` (or a manual `/scan`) has left
 * the meta + kline queues.
 *
 * What counts as "the batch is done":
 *   - Every envelope tagged with the batch's `batchId` has emitted a
 *     terminal event (succeeded OR failed-past-retries) on either queue.
 *   - Empty batches (no diff to enqueue) settle immediately so the
 *     pipeline never stalls on a no-op cron tick.
 *
 * What settle runs (in order):
 *   1. `BlacklistService.refresh()` — recompute the A-share blacklist.
 *      This is **not** done up-front any more so the meta + kline
 *      sync work always operates on yesterday's blacklist; the result
 *      flows into the *next* batch's cache-inspector pass.
 *   2. Full dynamic-sectors recompute — every `kind === 'dynamic'`
 *      sector in `SectorsStore` is re-screened with bounded concurrency.
 *
 * Settlement failures are logged but do not roll back the batch (which
 * is already done); the next 16:00 cron will retry.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { newTraceId } from '@quant/shared';

import { BlacklistService } from '../blacklist/blacklist.service.js';
import { SectorsService } from '../sectors/sectors.service.js';
import { SectorsStore } from '../sectors/sectors.store.js';
import { KLINE_QUEUE, META_QUEUE } from './flight.token.js';
import type { InMemoryQueue } from './domain/in-memory-queue.js';
import type { JobTerminalEvent, KlineJob, MetaJob } from './domain/types.js';

/** Bounded concurrency for dynamic-sector recompute (each is a Flight RPC). */
const SECTOR_REFRESH_CONCURRENCY = 4;

interface BatchState {
  totalMeta: number;
  totalKline: number;
  settledMeta: number;
  settledKline: number;
  failedMeta: number;
  failedKline: number;
  readonly traceId: string;
  readonly startedAt: number;
}

export interface BatchRegistration {
  readonly batchId: string;
  readonly metaCount: number;
  readonly klineCount: number;
  readonly traceId: string;
}

@Injectable()
export class BatchSettler {
  private readonly logger = new Logger(BatchSettler.name);
  private readonly batches = new Map<string, BatchState>();
  /** Guards concurrent settle invocations for the same batchId. */
  private readonly settling = new Set<string>();

  constructor(
    @Inject(META_QUEUE) private readonly metaQueue: InMemoryQueue<MetaJob>,
    @Inject(KLINE_QUEUE) private readonly klineQueue: InMemoryQueue<KlineJob>,
    @Inject(BlacklistService) private readonly blacklist: BlacklistService,
    @Inject(SectorsService) private readonly sectors: SectorsService,
    @Inject(SectorsStore) private readonly sectorsStore: SectorsStore,
  ) {
    this.metaQueue.onTerminal((ev) => {
      this.handleTerminal(ev, 'meta');
    });
    this.klineQueue.onTerminal((ev) => {
      this.handleTerminal(ev, 'kline');
    });
  }

  /**
   * Register a batch the cron just enqueued. Called *after* `addBulk`
   * returns so the counts reflect the deduped totals.
   *
   * If both counts are 0 — no diff to apply — settle immediately so the
   * tail-off still runs (the blacklist is recomputed every 16:00
   * regardless of whether per-code work was needed).
   */
  register(reg: BatchRegistration): void {
    const total = reg.metaCount + reg.klineCount;
    if (total === 0) {
      this.logger.log(`batch_empty batch_id=${reg.batchId} trace_id=${reg.traceId} — settling now`);
      void this.settle(reg.batchId, reg.traceId);
      return;
    }
    this.batches.set(reg.batchId, {
      totalMeta: reg.metaCount,
      totalKline: reg.klineCount,
      settledMeta: 0,
      settledKline: 0,
      failedMeta: 0,
      failedKline: 0,
      traceId: reg.traceId,
      startedAt: Date.now(),
    });
    this.logger.log(
      `batch_registered batch_id=${reg.batchId} meta=${String(reg.metaCount)} kline=${String(reg.klineCount)} trace_id=${reg.traceId}`,
    );
  }

  private handleTerminal(
    event: JobTerminalEvent<MetaJob> | JobTerminalEvent<KlineJob>,
    queueKind: 'meta' | 'kline',
  ): void {
    const data = event.envelope.data;
    const batchId = data.batchId;
    if (batchId === undefined) return; // ad-hoc push, not a tracked batch
    const state = this.batches.get(batchId);
    if (state === undefined) return; // unknown batch (settler restarted mid-flight)
    if (queueKind === 'meta') {
      state.settledMeta += 1;
      if (event.reason === 'failed') state.failedMeta += 1;
    } else {
      state.settledKline += 1;
      if (event.reason === 'failed') state.failedKline += 1;
    }
    if (state.settledMeta >= state.totalMeta && state.settledKline >= state.totalKline) {
      void this.settle(batchId, state.traceId);
    }
  }

  private async settle(batchId: string, traceId: string): Promise<void> {
    if (this.settling.has(batchId)) return;
    this.settling.add(batchId);
    const state = this.batches.get(batchId);
    this.batches.delete(batchId);
    const elapsed = state ? Date.now() - state.startedAt : 0;
    this.logger.log(
      `batch_settling batch_id=${batchId} trace_id=${traceId} meta_failed=${String(state?.failedMeta ?? 0)} kline_failed=${String(state?.failedKline ?? 0)} batch_elapsed_ms=${String(elapsed)}`,
    );
    try {
      await this.runBlacklist(traceId);
      await this.refreshAllDynamicSectors(traceId);
    } finally {
      this.settling.delete(batchId);
    }
  }

  private async runBlacklist(traceId: string): Promise<void> {
    try {
      const snap = await this.blacklist.refresh(traceId);
      this.logger.log(
        `batch_settle_blacklist size=${String(snap.codes.length)} trace_id=${traceId}`,
      );
    } catch (err) {
      this.logger.warn(
        `batch_settle_blacklist_failed err=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async refreshAllDynamicSectors(traceId: string): Promise<void> {
    const all = this.sectorsStore.list();
    const dynamics = all.filter((s) => s.kind === 'dynamic' && s.screenPlan !== undefined);
    if (dynamics.length === 0) {
      this.logger.log(`batch_settle_sectors_skipped reason=no_dynamic trace_id=${traceId}`);
      return;
    }
    let ok = 0;
    let failed = 0;
    let cursor = 0;
    const total = dynamics.length;
    const next = (): { idx: number } | null => {
      if (cursor >= total) return null;
      const idx = cursor;
      cursor += 1;
      return { idx };
    };
    const work = async (): Promise<void> => {
      for (;;) {
        const slot = next();
        if (slot === null) return;
        const sector = dynamics[slot.idx];
        if (sector === undefined) return;
        const sectorTraceId = newTraceId();
        try {
          await this.sectors.refreshDynamic(sector.createdBy, sector.id, sectorTraceId);
          ok += 1;
        } catch (err) {
          failed += 1;
          this.logger.warn(
            `dynamic_sector_refresh_failed id=${sector.id} owner=${sector.createdBy} trace_id=${sectorTraceId} err=${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    };
    const concurrency = Math.min(SECTOR_REFRESH_CONCURRENCY, total);
    await Promise.all(Array.from({ length: concurrency }, () => work()));
    this.logger.log(
      `batch_settle_sectors_done ok=${String(ok)} failed=${String(failed)} total=${String(total)} trace_id=${traceId}`,
    );
  }
}
