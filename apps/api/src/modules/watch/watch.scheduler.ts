/**
 * Watch master tick (`docs/modules/W-0-watch.md` §8).
 *
 * Single `setInterval` (5s) ticks every enabled task whose
 * `lastTickAt + intervalSec*1000` has elapsed and whose market is
 * currently open. Quotes are fetched concurrently (`Promise.allSettled`)
 * so a single upstream failure cannot stall the whole batch.
 *
 * Pushes go through `WatchNotifier` and respect `pushIntervalSec`.
 * `remaining` decrements on each push; reaching zero auto-disables the
 * task (per §8 of the doc).
 */

import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { newTraceId, type WatchMarket, type WatchTask } from '@quant/shared';
import { Decimal } from 'decimal.js';
import { decimalQuoteFromDto } from './domain/decimal-mapper.js';
import { evaluate } from './domain/evaluate.js';
import { buildPayload } from './domain/format.js';
import { isMarketOpen, marketTradingDayKey } from './domain/market-hours.js';
import { WATCH_QUOTE_PORT, type WatchQuotePort } from './domain/watch-port.js';
import { WatchTaskStore } from './watch-task.store.js';
import { WATCH_NOTIFIER, type WatchNotifier } from './watch-notifier.js';

const MASTER_TICK_MS = 5_000;

/**
 * A spot quote whose `ts` deviates from server time by more than this
 * is treated as stale: the tick is logged and the task is bumped to the
 * next cadence without evaluating any condition. Guards against pricing
 * decisions on data that an upstream may still be replaying through a
 * cache, and keeps prev-baseline comparisons coherent.
 */
const STALE_QUOTE_MAX_MS = 30 * 60 * 1000;

/**
 * Did the previous successful sample (within the current trading day)
 * already match? Used to suppress the second, third, … matches in a
 * continuous match streak — only the leading edge is a "hit".
 */
function previousSampleMatched(task: WatchTask, now: Date): boolean {
  const { lastSampleAt, lastMatchAt } = task;
  if (lastSampleAt === null || lastMatchAt === null) return false;
  if (lastMatchAt !== lastSampleAt) return false;
  return marketTradingDayKey(task.market, new Date(lastSampleAt)) === marketTradingDayKey(task.market, now);
}

/**
 * Resolve the cached prev-sample price for `prev`-kind evaluation.
 * Returns null when there is no prior sample or the cached one falls
 * outside the current trading day.
 */
function resolvePrevSamplePrice(task: WatchTask, now: Date): Decimal | null {
  if (task.lastSamplePrice === null || task.lastSampleAt === null) return null;
  const sampleDay = marketTradingDayKey(task.market, new Date(task.lastSampleAt));
  if (sampleDay !== marketTradingDayKey(task.market, now)) return null;
  return new Decimal(task.lastSamplePrice);
}

@Injectable()
export class WatchScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WatchScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private destroyed = false;
  private tickInFlight: Promise<void> | null = null;

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
    // Compute trading-window status once per master tick instead of
    // re-running the predicate per task; bail out early if every market
    // we cover is closed so we don't even snapshot the task store.
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

  private async processOne(task: WatchTask, now: Date, nowMs: number): Promise<void> {
    const traceId = newTraceId();
    let quoteDto;
    try {
      quoteDto = await this.port.fetchOne(task.market, task.code, traceId);
    } catch (err) {
      this.logger.warn(
        `watch_quote_fail market=${task.market} code=${task.code} trace_id=${traceId} err=${String(err)}`,
      );
      // Still bump lastTickAt to honour the cadence even on failure.
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
      // Bump cadence without touching sample/match state — stale data
      // must not feed into prev-baseline comparisons or hit detection.
      await this.store.patch(task.market, task.code, (t) => ({
        ...t,
        lastTickAt: now.toISOString(),
      }));
      return;
    }

    const decimalQuote = decimalQuoteFromDto(quoteDto);
    const prevSamplePrice = resolvePrevSamplePrice(task, now);
    const matched = task.conditions.filter((c) =>
      evaluate({ quote: decimalQuote, prevSamplePrice }, c),
    );
    // "Hit" is edge-triggered: between two adjacent successful samples,
    // only a not-match → match transition counts — except for the
    // `prev` baseline (tick-over-tick by construction), which reports
    // every step in a sustained move as a hit.
    // See `docs/modules/W-0-watch.md` §4.
    const matchedHasPrev = matched.some((c) => c.kind === 'pct' && c.baseline === 'prev');
    const isHit =
      matched.length > 0 && (matchedHasPrev || !previousSampleMatched(task, now));
    const nowIso = now.toISOString();
    const nextSamplePriceStr = decimalQuote.last.toString();

    await this.store.patch(task.market, task.code, (t) => {
      const baseUpdate: WatchTask = {
        ...t,
        lastTickAt: nowIso,
        lastSampleAt: nowIso,
        lastSamplePrice: nextSamplePriceStr,
        ...(matched.length > 0 ? { lastMatchAt: nowIso } : {}),
      };
      if (!isHit) return baseUpdate;
      // Throttle: only push if pushIntervalSec elapsed since lastPushAt.
      if (t.lastPushAt !== null) {
        const lastPushMs = Date.parse(t.lastPushAt);
        if (!Number.isNaN(lastPushMs) && nowMs < lastPushMs + t.pushIntervalSec * 1000) {
          return baseUpdate;
        }
      }
      // Mutation order: bump push state synchronously; actual webhook
      // call happens after the patch completes (below).
      const nextRemaining = t.remaining === null ? null : Math.max(0, t.remaining - 1);
      return {
        ...baseUpdate,
        lastPushAt: nowIso,
        hitCount: t.hitCount + 1,
        remaining: nextRemaining,
        enabled: nextRemaining === 0 ? false : t.enabled,
      };
    });

    if (isHit && task.notifySlack) {
      // Re-read to confirm the patch actually pushed (could have been
      // skipped by throttle inside the closure).
      const after = this.store.get(task.market, task.code);
      if (after !== undefined && after.lastPushAt === nowIso) {
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
  }
}
