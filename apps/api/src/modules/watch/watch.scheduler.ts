/**
 * Watch master tick (`docs/modules/06-watch.md` §8).
 *
 * Single `setInterval` (5s) ticks every enabled task whose
 * `lastTickAt + intervalSec*1000` has elapsed and whose market is
 * currently open. Quotes are fetched concurrently (`Promise.allSettled`)
 * so a single upstream failure cannot stall the whole batch.
 *
 * Hit semantics: a fired evaluation is a *hit* iff **both** gates clear:
 *   - Price gate — `|last - lastHitPrice| / lastHitPrice >= 2 %`, OR
 *     `lastHitPrice == null` (first hit / new trading day).
 *   - Time gate — `now >= lastPushAt + pushIntervalSec*1000`, OR
 *     `lastPushAt == null`.
 *
 * `remaining` decrements on each fired hit; reaching zero auto-disables
 * the task.
 */

import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  WATCH_TREND_WINDOW_MAX_SEC,
  newTraceId,
  type WatchMarket,
  type WatchTask,
} from '@quant/shared';
import { Decimal } from 'decimal.js';
import { decimalQuoteFromDto } from './domain/decimal-mapper.js';
import { evaluate, type IntradaySample } from './domain/evaluate.js';
import { buildPayload } from './domain/format.js';
import { isMarketOpen, marketTradingDayKey } from './domain/market-hours.js';
import { WATCH_QUOTE_PORT, type WatchQuotePort } from './domain/watch-port.js';
import { WatchTaskStore } from './watch-task.store.js';
import { WATCH_NOTIFIER, type WatchNotifier } from './watch-notifier.js';

const MASTER_TICK_MS = 5_000;

/** Stale quote — bump cadence without evaluating, do not pollute samples. */
const STALE_QUOTE_MAX_MS = 30 * 60 * 1000;

/** Min ±% drift of `last` from `lastHitPrice` to count as a hit. */
const HIT_PRICE_DELTA_PCT = new Decimal('2');

/** Per-task in-memory intraday sample series + the day they belong to. */
interface IntradayBuffer {
  readonly day: string;
  samples: IntradaySample[];
}

@Injectable()
export class WatchScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WatchScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private destroyed = false;
  private tickInFlight: Promise<void> | null = null;
  /**
   * Per-task intraday sample buffer for the `trend` baseline. Keyed by
   * `market:code`. In-memory only — not persisted across restarts; a
   * cold restart re-warms over the next ~maxWindow seconds. Trimmed by
   * wall-clock window so the buffer's wall span never exceeds
   * `max(trend.window) + tickInterval` for the task.
   */
  private readonly samples = new Map<string, IntradayBuffer>();

  constructor(
    @Inject(WatchTaskStore) private readonly store: WatchTaskStore,
    @Inject(WATCH_QUOTE_PORT) private readonly port: WatchQuotePort,
    @Inject(WATCH_NOTIFIER) private readonly notifier: WatchNotifier,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.store.load();
    this.timer = setInterval(() => {
      void this.safeTick();
    }, MASTER_TICK_MS);
    this.logger.log(`watch scheduler armed — tick=${String(MASTER_TICK_MS)}ms`);
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (this.tickInFlight !== null) {
      await this.tickInFlight.catch(() => undefined);
    }
    await this.store.flushNow();
  }

  /** Run one master tick. Coalesces with any in-flight tick. */
  async tick(now: Date = new Date()): Promise<void> {
    if (this.destroyed) return;
    if (this.tickInFlight !== null) {
      await this.tickInFlight;
      return;
    }
    this.tickInFlight = this.runTick(now).finally(() => {
      this.tickInFlight = null;
    });
    await this.tickInFlight;
  }

  private async safeTick(): Promise<void> {
    try {
      await this.tick();
    } catch (err) {
      this.logger.warn(`watch_tick_crashed err=${String(err)}`);
    }
  }

  private async runTick(now: Date): Promise<void> {
    const nowMs = now.getTime();
    const marketsOpen: Readonly<Record<WatchMarket, boolean>> = {
      a: isMarketOpen('a', now),
      hk: isMarketOpen('hk', now),
      us: isMarketOpen('us', now),
    };
    if (!marketsOpen.a && !marketsOpen.hk && !marketsOpen.us) return;

    const due = this.store.snapshot().filter((t) => this.isDue(t, marketsOpen, nowMs));
    if (due.length === 0) return;

    await Promise.allSettled(due.map((t) => this.processOne(t, now, nowMs)));
  }

  private isDue(
    task: WatchTask,
    marketsOpen: Readonly<Record<WatchMarket, boolean>>,
    nowMs: number,
  ): boolean {
    if (!task.enabled) return false;
    if (!marketsOpen[task.market]) return false;
    if (task.lastTickAt === null) return true;
    const lastMs = Date.parse(task.lastTickAt);
    if (Number.isNaN(lastMs)) return true;
    return nowMs >= lastMs + task.intervalSec * 1000;
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

  /**
   * Append the latest `(ts, price)` to the task's intraday buffer.
   * Resets the buffer when the trading day rolls over. Trims entries
   * older than `latestTs - maxWindowSec` so the buffer's wall-clock
   * span stays bounded. Returns the post-update snapshot for evaluation.
   */
  private updateSamples(
    task: WatchTask,
    now: Date,
    quoteTs: Date,
    last: Decimal,
  ): readonly IntradaySample[] {
    const key = `${task.market}:${task.code}`;
    const day = marketTradingDayKey(task.market, now);
    let buf = this.samples.get(key);
    if (buf === undefined || buf.day !== day) {
      buf = { day, samples: [] };
      this.samples.set(key, buf);
    }
    buf.samples.push({ ts: quoteTs, price: last });
    const maxWindowSec = this.maxWindowSecFor(task);
    if (maxWindowSec > 0) {
      // Keep enough history to cover the largest configured window plus
      // a one-tick buffer (so trim never strips the very sample the
      // resolver would pick at the cutoff).
      const cutoffMs = quoteTs.getTime() - (maxWindowSec * 1000 + task.intervalSec * 1000);
      while (buf.samples.length > 0 && buf.samples[0]!.ts.getTime() < cutoffMs) {
        buf.samples.shift();
      }
    }
    return buf.samples;
  }

  private async processOne(task: WatchTask, now: Date, nowMs: number): Promise<void> {
    const traceId = newTraceId();
    let quoteDto;
    try {
      quoteDto = await this.port.fetchOne(task.market, task.code, traceId);
    } catch (err) {
      this.logger.warn(
        `watch_quote_fail market=${task.market} code=${task.code} trace_id=${traceId} err=${String(err)}`,
      );
      await this.store.patch(task.market, task.code, (t) => ({
        ...t,
        lastTickAt: now.toISOString(),
      }));
      return;
    }

    const quoteTsMs = Date.parse(quoteDto.ts);
    const ageMs = Number.isNaN(quoteTsMs) ? Number.POSITIVE_INFINITY : Math.abs(nowMs - quoteTsMs);
    if (ageMs > STALE_QUOTE_MAX_MS) {
      this.logger.warn(
        `watch_quote_stale market=${task.market} code=${task.code} ts=${quoteDto.ts} age_ms=${String(ageMs)} trace_id=${traceId}`,
      );
      await this.store.patch(task.market, task.code, (t) => ({
        ...t,
        lastTickAt: now.toISOString(),
      }));
      return;
    }

    const decimalQuote = decimalQuoteFromDto(quoteDto);
    const quoteTs = new Date(quoteTsMs);
    const intradaySamples = this.updateSamples(task, now, quoteTs, decimalQuote.last);
    const matched = task.conditions.filter((c) =>
      evaluate({ quote: decimalQuote, intradaySamples }, c),
    );

    const isHit =
      matched.length > 0 &&
      this.priceTriggersHit(task, now, decimalQuote.last) &&
      this.timeTriggersHit(task, nowMs);
    const nowIso = now.toISOString();
    const nextHitPriceStr = decimalQuote.last.toString();

    await this.store.patch(task.market, task.code, (t) => {
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
      const payload = buildPayload({
        code: task.code,
        name: task.name,
        market: task.market,
        quote: decimalQuote,
        matched,
      });
      await this.notifier.send(payload, traceId);
    }
  }

  /**
   * Decide whether the price gate clears. New trading day or never-hit
   * ⇒ always fire; otherwise require ≥ HIT_PRICE_DELTA_PCT % drift
   * from the previous hit price.
   */
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

  /**
   * Decide whether the `pushIntervalSec` time gate clears. No prior
   * push ⇒ always fire; otherwise require the configured interval to
   * have elapsed.
   */
  private timeTriggersHit(task: WatchTask, nowMs: number): boolean {
    if (task.lastPushAt === null) return true;
    const lastMs = Date.parse(task.lastPushAt);
    if (Number.isNaN(lastMs)) return true;
    return nowMs >= lastMs + task.pushIntervalSec * 1000;
  }
}
