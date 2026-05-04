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
import { newTraceId, type WatchTask } from '@quant/shared';
import { decimalQuoteFromDto } from './domain/decimal-mapper.js';
import { evaluate } from './domain/evaluate.js';
import { buildPayload } from './domain/format.js';
import { isMarketOpen } from './domain/market-hours.js';
import {
  WATCH_QUOTE_PORT,
  type WatchQuotePort,
} from './domain/watch-port.js';
import { WatchTaskStore } from './watch-task.store.js';
import {
  WATCH_NOTIFIER,
  type WatchNotifier,
} from './watch-notifier.js';

const MASTER_TICK_MS = 5_000;

@Injectable()
export class WatchScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WatchScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private destroyed = false;
  private tickInFlight: Promise<void> | null = null;

  constructor(
    private readonly store: WatchTaskStore,
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
    const due = this.store.snapshot().filter((t) => this.isDue(t, now, nowMs));
    if (due.length === 0) return;

    await Promise.allSettled(due.map((t) => this.processOne(t, now, nowMs)));
  }

  private isDue(task: WatchTask, now: Date, nowMs: number): boolean {
    if (!task.enabled) return false;
    if (!isMarketOpen(task.market, now)) return false;
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

    const decimalQuote = decimalQuoteFromDto(quoteDto);
    const hits = task.conditions.filter((c) => evaluate(decimalQuote, c));

    await this.store.patch(task.market, task.code, (t) => {
      const updated: WatchTask = { ...t, lastTickAt: now.toISOString() };
      if (hits.length === 0) return updated;
      // Throttle: only push if pushIntervalSec elapsed since lastPushAt.
      if (t.lastPushAt !== null) {
        const lastPushMs = Date.parse(t.lastPushAt);
        if (
          !Number.isNaN(lastPushMs) &&
          nowMs < lastPushMs + t.pushIntervalSec * 1000
        ) {
          return updated;
        }
      }
      // Mutation order: bump push state synchronously; actual webhook
      // call happens after the patch completes (below).
      const nextRemaining = t.remaining === null ? null : Math.max(0, t.remaining - 1);
      return {
        ...updated,
        lastPushAt: now.toISOString(),
        hitCount: t.hitCount + 1,
        remaining: nextRemaining,
        enabled: nextRemaining === 0 ? false : t.enabled,
      };
    });

    if (hits.length > 0 && task.notifySlack) {
      // Re-read to confirm the patch actually pushed (could have been
      // skipped by throttle inside the closure).
      const after = this.store.get(task.market, task.code);
      if (after !== undefined && after.lastPushAt === now.toISOString()) {
        const text = buildPayload({
          code: task.code,
          name: task.name,
          market: task.market,
          quote: decimalQuote,
          hits,
        });
        await this.notifier.send(text, traceId);
      }
    }
  }
}
