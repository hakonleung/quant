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
  QuantError,
  WATCH_TREND_WINDOW_MAX_SEC,
  newTraceId,
  type WatchMarket,
  type WatchTask,
} from '@quant/shared';
import { Decimal } from 'decimal.js';
import { ChannelService } from '../channel/channel.service.js';
import { UserStore } from '../auth/user.store.js';
import { decimalQuoteFromDto } from './domain/decimal-mapper.js';
import {
  evaluate,
  type IntradaySample,
  type KlineMaRef,
} from './domain/evaluate.js';
import { buildBatchPayload, buildPayload, type HitArgs } from './domain/format.js';
import { isMarketOpen, marketTradingDayKey } from './domain/market-hours.js';
import {
  WATCH_KLINE_REF_PORT,
  WATCH_QUOTE_PORT,
  type WatchKlineRefPort,
  type WatchQuotePort,
} from './domain/watch-port.js';
import { WatchGroupStore } from './watch-group.store.js';
import { WatchTaskStore } from './watch-task.store.js';

const MASTER_TICK_MS = 5_000;
const HIT_BATCH_WINDOW_MS = 3_000;

/** Stale quote — bump cadence without evaluating, do not pollute samples. */
const STALE_QUOTE_MAX_MS = 30 * 60 * 1000;

/** Min ±% drift of `last` from `lastHitPrice` to count as a hit. */
const HIT_PRICE_DELTA_PCT = new Decimal('2');

/**
 * Per-market upstream-fetch concurrency. Each market gets its own pool
 * because the akshare endpoints behind each market are different upstreams
 * (Eastmoney spot for A, hist_min_em for HK/US) — a US outage shouldn't
 * starve A/HK fetches.
 */
const MARKET_FETCH_CONCURRENCY = 8;

/**
 * Circuit-breaker base cooldown (ms) after a transport-class fetch failure.
 * Doubles on each consecutive failure up to {@link MARKET_COOLDOWN_CAP_MS},
 * resets to 0 (== healthy) on the first successful fetch.
 */
const MARKET_COOLDOWN_BASE_MS = 3_000;
const MARKET_COOLDOWN_CAP_MS = 30_000;

/** Pool over `max` concurrent `run` calls; rest queue FIFO. */
class Semaphore {
  private inFlight = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inFlight >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.inFlight += 1;
    try {
      return await fn();
    } finally {
      this.inFlight -= 1;
      const next = this.queue.shift();
      if (next !== undefined) next();
    }
  }
}

/**
 * Per-market transport health. Trips on `transport`-classed failures
 * (Python side surfaces `details.reason === "transport"` via the Flight
 * error envelope); on trip, all due tasks in that market are skipped
 * until `cooldownUntilMs`. Doubling cooldown lets persistent upstream
 * failures back off without a fixed bound; a single success resets.
 */
class MarketTransportHealth {
  private cooldownUntilMs = 0;
  private consecutiveTrips = 0;

  isHealthy(nowMs: number): boolean {
    return nowMs >= this.cooldownUntilMs;
  }

  trip(nowMs: number): number {
    this.consecutiveTrips += 1;
    const factor = Math.min(2 ** (this.consecutiveTrips - 1), MARKET_COOLDOWN_CAP_MS / MARKET_COOLDOWN_BASE_MS);
    const delay = Math.min(MARKET_COOLDOWN_BASE_MS * factor, MARKET_COOLDOWN_CAP_MS);
    this.cooldownUntilMs = nowMs + delay;
    return delay;
  }

  reset(): void {
    this.cooldownUntilMs = 0;
    this.consecutiveTrips = 0;
  }
}

function isTransportError(err: unknown): boolean {
  return err instanceof QuantError && err.details['reason'] === 'transport';
}

/** Per-task in-memory intraday sample series + the day they belong to. */
interface IntradayBuffer {
  readonly day: string;
  samples: IntradaySample[];
}

/** Cached MA ref (per A-share code) keyed by the trading day it was loaded under. */
interface MaRefEntry {
  readonly day: string;
  readonly ref: KlineMaRef | null;
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

  /**
   * MA snapshot cache for A-share codes — keyed by `code`. Lazily loaded
   * on first MA-condition tick of each trading day; reused across users
   * because kline data is shared. `null` ref means upstream returned
   * insufficient history (don't fire MA conditions for this code today).
   */
  private readonly maRefs = new Map<string, MaRefEntry>();
  /** In-flight MA-ref loads, dedupes concurrent fetches for the same code. */
  private readonly maRefInFlight = new Map<string, Promise<KlineMaRef | null>>();

  /** Pending hits waiting to be batched, keyed by userId. */
  private readonly hitBuffer = new Map<string, HitArgs[]>();
  /** Debounce timers for flushing each user's hit buffer. */
  private readonly flushTimers = new Map<string, NodeJS.Timeout>();

  /** Per-market concurrent-fetch pool (size = {@link MARKET_FETCH_CONCURRENCY}). */
  private readonly fetchPools: Record<WatchMarket, Semaphore> = {
    a: new Semaphore(MARKET_FETCH_CONCURRENCY),
    hk: new Semaphore(MARKET_FETCH_CONCURRENCY),
    us: new Semaphore(MARKET_FETCH_CONCURRENCY),
  };

  /** Per-market circuit-breaker for transport failures. */
  private readonly health: Record<WatchMarket, MarketTransportHealth> = {
    a: new MarketTransportHealth(),
    hk: new MarketTransportHealth(),
    us: new MarketTransportHealth(),
  };

  constructor(
    @Inject(WatchTaskStore) private readonly store: WatchTaskStore,
    @Inject(WatchGroupStore) private readonly groups: WatchGroupStore,
    @Inject(WATCH_QUOTE_PORT) private readonly port: WatchQuotePort,
    @Inject(WATCH_KLINE_REF_PORT) private readonly klineRefPort: WatchKlineRefPort,
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
    for (const t of this.flushTimers.values()) clearTimeout(t);
    this.flushTimers.clear();
    if (this.tickInFlight !== null) {
      await this.tickInFlight.catch(() => undefined);
    }
    await Promise.allSettled([...this.hitBuffer.keys()].map((u) => this.flushHits(u)));
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

    const due = await this.collectDue(marketsOpen, nowMs);
    if (due.length === 0) return;

    // Bound concurrency per market — different markets hit different
    // upstream endpoints, so US misbehaviour shouldn't starve A/HK.
    await Promise.allSettled(
      due.map((u) =>
        this.fetchPools[u.task.market].run(() => this.processOne(u.userId, u.task, now, nowMs)),
      ),
    );
  }

  /**
   * Walk every user's tasks once; return the ones that are due and not
   * currently in their market's transport-cooldown window. Tasks skipped
   * by cooldown do NOT have `lastTickAt` bumped — they remain due the
   * instant the cooldown lifts.
   */
  private async collectDue(
    marketsOpen: Readonly<Record<WatchMarket, boolean>>,
    nowMs: number,
  ): Promise<UserTask[]> {
    const due: UserTask[] = [];
    const skippedByMarket: Partial<Record<WatchMarket, number>> = {};
    for (const user of this.users.list()) {
      const tasks = await this.store.snapshot(user.id);
      const groups = await this.groups.list(user.id);
      const disabledGroups = new Set<string>();
      for (const g of groups) if (!g.enabled) disabledGroups.add(g.name);
      for (const t of tasks) {
        if (disabledGroups.has(t.groupName)) continue;
        if (!this.isDue(t, marketsOpen, nowMs)) continue;
        if (!this.health[t.market].isHealthy(nowMs)) {
          skippedByMarket[t.market] = (skippedByMarket[t.market] ?? 0) + 1;
          continue;
        }
        due.push({ userId: user.id, task: t });
      }
    }
    for (const [market, count] of Object.entries(skippedByMarket)) {
      this.logger.debug(`watch_market_cooldown market=${market} skipped=${String(count)}`);
    }
    return due;
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

  /**
   * Fetch a quote, updating per-market transport health. Returns the
   * quote DTO on success, or `null` after recording a failure (which
   * bumps `lastTickAt` and, for transport errors, trips the breaker).
   */
  private async fetchWithHealth(
    userId: string,
    task: WatchTask,
    traceId: string,
    now: Date,
    nowMs: number,
  ): Promise<Awaited<ReturnType<WatchQuotePort['fetchOne']>> | null> {
    try {
      const quoteDto = await this.port.fetchOne(task.market, task.code, traceId);
      this.health[task.market].reset();
      return quoteDto;
    } catch (err) {
      if (isTransportError(err)) {
        const cooldownMs = this.health[task.market].trip(nowMs);
        this.logger.warn(
          `watch_market_transport_trip market=${task.market} code=${task.code} cooldown_ms=${String(cooldownMs)} trace_id=${traceId}`,
        );
      }
      this.logger.warn(
        `watch_quote_fail user=${userId} market=${task.market} code=${task.code} trace_id=${traceId} err=${String(err)}`,
      );
      await this.store.patch(userId, task.market, task.code, (t) => ({
        ...t,
        lastTickAt: now.toISOString(),
      }));
      return null;
    }
  }

  private async processOne(
    userId: string,
    task: WatchTask,
    now: Date,
    nowMs: number,
  ): Promise<void> {
    const traceId = newTraceId();
    const quoteDto = await this.fetchWithHealth(userId, task, traceId, now, nowMs);
    if (quoteDto === null) return;

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
      this.enqueueHit(userId, {
        code: task.code,
        name: task.name,
        market: task.market,
        quote: decimalQuote,
        matched,
      });
    }
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

  /**
   * Load (or reuse) the A-share MA snapshot for `task.code`. Returns
   * `null` if the task has no MA conditions, the market is non-A, or
   * the upstream lacks history — all three are silent no-fire paths.
   * Cached per trading day; refreshed when the day key rolls over.
   */
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
}
