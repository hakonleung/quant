/**
 * Watch master tick (`docs/modules/06-watch.md` §8).
 *
 * Multi-user: each tick iterates every known user, pulls their tasks,
 * filters by `(enabled, market open, intervalSec elapsed)`, and fires
 * quote fetches in one big `Promise.allSettled` batch. The
 * `WatchQuotePort` adapter dedupes by `(market, code)` so two users
 * watching the same symbol still cost one upstream call.
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
import { ChannelService } from '../channel/channel.service.js';
import { UserStore } from '../auth/user.store.js';
import { decimalQuoteFromDto } from './domain/decimal-mapper.js';
import { evaluate, type IntradaySample } from './domain/evaluate.js';
import { buildPayload } from './domain/format.js';
import { isMarketOpen, marketTradingDayKey } from './domain/market-hours.js';
import { WATCH_QUOTE_PORT, type WatchQuotePort } from './domain/watch-port.js';
import { WatchTaskStore } from './watch-task.store.js';

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

interface UserTask {
  readonly userId: string;
  readonly task: WatchTask;
}

@Injectable()
export class WatchScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WatchScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private destroyed = false;
  private tickInFlight: Promise<void> | null = null;
  /**
   * Per-(user,task) intraday sample buffer for the `trend` baseline.
   * Keyed by `userId|market:code`. In-memory only.
   */
  private readonly samples = new Map<string, IntradayBuffer>();

  constructor(
    @Inject(WatchTaskStore) private readonly store: WatchTaskStore,
    @Inject(WATCH_QUOTE_PORT) private readonly port: WatchQuotePort,
    @Inject(ChannelService) private readonly channels: ChannelService,
    @Inject(UserStore) private readonly users: UserStore,
  ) {}

  onModuleInit(): void {
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
    await this.store.flushAll();
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

    const due: UserTask[] = [];
    for (const user of this.users.list()) {
      const tasks = await this.store.snapshot(user.id);
      for (const t of tasks) {
        if (this.isDue(t, marketsOpen, nowMs)) due.push({ userId: user.id, task: t });
      }
    }
    if (due.length === 0) return;

    await Promise.allSettled(due.map((u) => this.processOne(u.userId, u.task, now, nowMs)));
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

  private async processOne(
    userId: string,
    task: WatchTask,
    now: Date,
    nowMs: number,
  ): Promise<void> {
    const traceId = newTraceId();
    let quoteDto;
    try {
      quoteDto = await this.port.fetchOne(task.market, task.code, traceId);
    } catch (err) {
      this.logger.warn(
        `watch_quote_fail user=${userId} market=${task.market} code=${task.code} trace_id=${traceId} err=${String(err)}`,
      );
      await this.store.patch(userId, task.market, task.code, (t) => ({
        ...t,
        lastTickAt: now.toISOString(),
      }));
      return;
    }

    const quoteTsMs = Date.parse(quoteDto.ts);
    const ageMs = Number.isNaN(quoteTsMs) ? Number.POSITIVE_INFINITY : Math.abs(nowMs - quoteTsMs);
    if (ageMs > STALE_QUOTE_MAX_MS) {
      this.logger.warn(
        `watch_quote_stale user=${userId} market=${task.market} code=${task.code} ts=${quoteDto.ts} age_ms=${String(ageMs)} trace_id=${traceId}`,
      );
      await this.store.patch(userId, task.market, task.code, (t) => ({
        ...t,
        lastTickAt: now.toISOString(),
      }));
      return;
    }

    const decimalQuote = decimalQuoteFromDto(quoteDto);
    const quoteTs = new Date(quoteTsMs);
    const intradaySamples = this.updateSamples(userId, task, now, quoteTs, decimalQuote.last);
    const matched = task.conditions.filter((c) =>
      evaluate({ quote: decimalQuote, intradaySamples }, c),
    );

    const isHit =
      matched.length > 0 &&
      this.priceTriggersHit(task, now, decimalQuote.last) &&
      this.timeTriggersHit(task, nowMs);
    const nowIso = now.toISOString();
    const nextHitPriceStr = decimalQuote.last.toString();

    await this.store.patch(userId, task.market, task.code, (t) => {
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
      await this.channels.broadcast(
        {
          text: payload.text,
          kind: 'watch.hit',
          meta: {
            market: task.market,
            code: task.code,
            name: task.name,
            last: decimalQuote.last.toString(),
            userId,
          },
        },
        { traceId, source: 'system' },
      );
    }
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
}
