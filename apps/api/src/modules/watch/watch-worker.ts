/**
 * Watch worker — consumes `WatchJob` envelopes pushed by
 * {@link WatchScheduler} and runs the full per-task pipeline:
 *
 *   1. Fetch quote via {@link WatchQuotePort} (Flight under the hood).
 *   2. Apply trading-day rollover and intraday sample buffering.
 *   3. Lazy-load MA reference (A-share only, MA-conditions only).
 *   4. Evaluate the task's conditions; gate the hit by price/time drift.
 *   5. Patch `WatchTaskStore` (lastTickAt / lastPushAt / hitCount /
 *      remaining / enabled). Hits get batched per-user and flushed
 *      through {@link ChannelService} on a 3s debounce window.
 *
 * Concurrency + per-pool backoff are the queue's responsibility — this
 * class only throws on transport-class errors so the queue can pause
 * the affected market and drain.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { WATCH_TREND_WINDOW_MAX_SEC, newTraceId, type WatchTask } from '@quant/shared';
import { Decimal } from 'decimal.js';
import { ChannelService } from '../channel/channel.service.js';
import { decimalQuoteFromDto } from './domain/decimal-mapper.js';
import { evaluate, type IntradaySample, type KlineMaRef } from './domain/evaluate.js';
import { buildBatchPayload, buildPayload, type HitArgs } from './domain/format.js';
import { marketTradingDayKey } from './domain/market-hours.js';
import {
  WATCH_KLINE_REF_PORT,
  WATCH_QUOTE_PORT,
  type WatchKlineRefPort,
  type WatchQuotePort,
} from './domain/watch-port.js';
import type { WatchJob } from './domain/watch-job.js';
import type { JobEnvelope, JobProcessor, ReQueue } from '../orchestration/domain/types.js';
import { WatchTaskStore } from './watch-task.store.js';

/** Stale quote — bump cadence without evaluating, do not pollute samples. */
const STALE_QUOTE_MAX_MS = 30 * 60 * 1000;

/** Min ±% drift of `last` from `lastHitPrice` to count as a hit. */
const HIT_PRICE_DELTA_PCT = new Decimal('2');

/** Hit flush debounce. */
const HIT_BATCH_WINDOW_MS = 3_000;

interface IntradayBuffer {
  readonly day: string;
  samples: IntradaySample[];
}

interface MaRefEntry {
  readonly day: string;
  readonly ref: KlineMaRef | null;
}

@Injectable()
export class WatchWorker implements JobProcessor<WatchJob> {
  private readonly logger = new Logger(WatchWorker.name);
  /** Per-(user,task) intraday sample series. Key = `userId|market:code`. */
  private readonly samples = new Map<string, IntradayBuffer>();
  /** A-share MA snapshot cache, keyed by code, valid per trading day. */
  private readonly maRefs = new Map<string, MaRefEntry>();
  private readonly maRefInFlight = new Map<string, Promise<KlineMaRef | null>>();
  /** Per-user pending hits. */
  private readonly hitBuffer = new Map<string, HitArgs[]>();
  private readonly flushTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    @Inject(WATCH_QUOTE_PORT) private readonly port: WatchQuotePort,
    @Inject(WATCH_KLINE_REF_PORT) private readonly klineRefPort: WatchKlineRefPort,
    @Inject(ChannelService) private readonly channels: ChannelService,
    @Inject(WatchTaskStore) private readonly store: WatchTaskStore,
  ) {}

  async process(job: JobEnvelope<WatchJob>, _queue: ReQueue<WatchJob>): Promise<void> {
    const { userId, market, code } = job.data;
    const now = new Date();
    const nowMs = now.getTime();
    const task = (await this.store.get(userId, market, code)) ?? null;
    if (task === null) return; // task removed between push and consume
    const traceId = newTraceId();

    let quoteDto: Awaited<ReturnType<WatchQuotePort['fetchOne']>>;
    try {
      quoteDto = await this.port.fetchOne(market, code, traceId);
    } catch (err) {
      // Bump lastTickAt so the next 5s tick doesn't re-enqueue
      // immediately, then re-throw so the queue applies its pool /
      // task backoff policy.
      await this.store.patch(userId, market, code, (t) => ({
        ...t,
        lastTickAt: now.toISOString(),
      }));
      this.logger.warn(
        `watch_quote_fail user=${userId} market=${market} code=${code} trace_id=${traceId} err=${String(err)}`,
      );
      throw err;
    }

    const quoteTsMs = Date.parse(quoteDto.ts);
    const ageMs = Number.isNaN(quoteTsMs) ? Number.POSITIVE_INFINITY : Math.abs(nowMs - quoteTsMs);
    if (ageMs > STALE_QUOTE_MAX_MS) {
      this.logger.warn(
        `watch_quote_stale user=${userId} market=${market} code=${code} ts=${quoteDto.ts} age_ms=${String(ageMs)} trace_id=${traceId}`,
      );
      await this.store.patch(userId, market, code, (t) => ({
        ...t,
        lastTickAt: now.toISOString(),
      }));
      return;
    }

    const decimalQuote = decimalQuoteFromDto(quoteDto);
    const quoteTs = new Date(quoteTsMs);
    const intradaySamples = this.updateSamples(userId, task, now, quoteTs, decimalQuote.last);
    const klineMaRef = await this.loadMaRefIfNeeded(task, now, traceId);
    const matched = task.conditions.filter((c) =>
      evaluate({ quote: decimalQuote, intradaySamples, klineMaRef }, c),
    );

    const isHit =
      matched.length > 0 &&
      this.priceTriggersHit(task, now, decimalQuote.last) &&
      this.timeTriggersHit(task, nowMs);
    const nowIso = now.toISOString();
    const nextHitPriceStr = decimalQuote.last.toString();

    await this.store.patch(userId, market, code, (t) => {
      const baseUpdate: WatchTask = {
        ...t,
        lastTickAt: nowIso,
        lastSampleAt: nowIso,
      };
      if (!isHit) return baseUpdate;
      const nextRemaining = t.remaining === null ? null : Math.max(0, t.remaining - 1);
      return {
        ...baseUpdate,
        lastPushAt: nowIso,
        lastHitPrice: nextHitPriceStr,
        hitCount: t.hitCount + 1,
        remaining: nextRemaining,
        enabled: nextRemaining === 0 ? false : t.enabled,
      };
    });

    if (isHit && task.notifySlack) {
      this.enqueueHit(userId, {
        code: task.code,
        name: task.name,
        market: task.market,
        quote: decimalQuote,
        matched,
      });
    }
  }

  /** Flush any pending hit batches — called on module destroy. */
  async shutdown(): Promise<void> {
    for (const t of this.flushTimers.values()) clearTimeout(t);
    this.flushTimers.clear();
    await Promise.allSettled([...this.hitBuffer.keys()].map((u) => this.flushHits(u)));
  }

  /** Largest `window` (seconds) referenced by this task's pct conditions. */
  private maxWindowSecFor(task: WatchTask): number {
    let max = 0;
    for (const c of task.conditions) {
      if (c.kind !== 'pct') continue;
      if (c.baseline !== 'trend') continue;
      if (c.window !== undefined && c.window > max) max = c.window;
    }
    return Math.min(max, WATCH_TREND_WINDOW_MAX_SEC);
  }

  private updateSamples(
    userId: string,
    task: WatchTask,
    now: Date,
    quoteTs: Date,
    last: Decimal,
  ): readonly IntradaySample[] {
    const key = `${userId}|${task.market}:${task.code}`;
    const day = marketTradingDayKey(task.market, now);
    let buf = this.samples.get(key);
    if (buf === undefined || buf.day !== day) {
      buf = { day, samples: [] };
      this.samples.set(key, buf);
    }
    buf.samples.push({ ts: quoteTs, price: last });
    const maxWindowSec = this.maxWindowSecFor(task);
    if (maxWindowSec > 0) {
      const cutoffMs = quoteTs.getTime() - (maxWindowSec * 1000 + task.intervalSec * 1000);
      while (buf.samples.length > 0 && buf.samples[0]!.ts.getTime() < cutoffMs) {
        buf.samples.shift();
      }
    }
    return buf.samples;
  }

  private async loadMaRefIfNeeded(
    task: WatchTask,
    now: Date,
    traceId: string,
  ): Promise<KlineMaRef | null> {
    if (task.market !== 'a') return null;
    if (!task.conditions.some((c) => c.kind === 'ma')) return null;
    const day = marketTradingDayKey(task.market, now);
    const cached = this.maRefs.get(task.code);
    if (cached !== undefined && cached.day === day) return cached.ref;
    const pending = this.maRefInFlight.get(task.code);
    if (pending !== undefined) return pending;
    const load = (async (): Promise<KlineMaRef | null> => {
      try {
        const ref = await this.klineRefPort.loadMaRef(task.code, traceId);
        this.maRefs.set(task.code, { day, ref });
        return ref;
      } catch (err) {
        this.logger.warn(
          `watch_ma_ref_fail code=${task.code} trace_id=${traceId} err=${String(err)}`,
        );
        this.maRefs.set(task.code, { day, ref: null });
        return null;
      } finally {
        this.maRefInFlight.delete(task.code);
      }
    })();
    this.maRefInFlight.set(task.code, load);
    return load;
  }

  private priceTriggersHit(task: WatchTask, now: Date, last: Decimal): boolean {
    if (task.lastHitPrice === null || task.lastPushAt === null) return true;
    const prevDay = marketTradingDayKey(task.market, new Date(task.lastPushAt));
    const today = marketTradingDayKey(task.market, now);
    if (prevDay !== today) return true;
    const prev = new Decimal(task.lastHitPrice);
    if (prev.lte(0)) return true;
    const driftPct = last.minus(prev).abs().div(prev).mul(100);
    return driftPct.gte(HIT_PRICE_DELTA_PCT);
  }

  private timeTriggersHit(task: WatchTask, nowMs: number): boolean {
    if (task.lastPushAt === null) return true;
    const lastMs = Date.parse(task.lastPushAt);
    if (Number.isNaN(lastMs)) return true;
    return nowMs >= lastMs + task.pushIntervalSec * 1000;
  }

  private enqueueHit(userId: string, hit: HitArgs): void {
    const buf = this.hitBuffer.get(userId) ?? [];
    buf.push(hit);
    this.hitBuffer.set(userId, buf);
    if (!this.flushTimers.has(userId)) {
      const timer = setTimeout(() => {
        void this.flushHits(userId);
      }, HIT_BATCH_WINDOW_MS);
      this.flushTimers.set(userId, timer);
    }
  }

  private async flushHits(userId: string): Promise<void> {
    const hits = this.hitBuffer.get(userId);
    this.hitBuffer.delete(userId);
    this.flushTimers.delete(userId);
    if (hits === undefined || hits.length === 0) return;
    const traceId = newTraceId();
    const payload = buildBatchPayload(hits);
    const hitMetas = hits.map((h) => ({
      market: h.market,
      code: h.code,
      name: h.name,
      last: h.quote.last.toString(),
      text: buildPayload(h).text,
    }));
    try {
      await this.channels.broadcast(
        {
          text: payload.text,
          kind: 'watch.hit',
          meta: { userId, hits: hitMetas },
        },
        { traceId, source: 'system' },
      );
    } catch (err) {
      this.logger.warn(
        `watch_hit_flush_failed user=${userId} count=${String(hits.length)} err=${String(err)}`,
      );
    }
  }
}
