/**
 * Watch master tick (`docs/modules/06-watch.md` §8).
 *
 * Producer-only role: each 5s tick walks every known user's tasks,
 * picks the ones whose `(enabled, market open, intervalSec elapsed)`
 * gate clears, and pushes one `WatchJob` per due task into the
 * per-market queue. The queue's concurrency + pool-backoff machinery
 * (see {@link InMemoryQueue}) handles upstream-throttling and proxy
 * outages uniformly with the orchestration queues.
 *
 * The actual fetch + evaluate + hit-batching path lives in
 * {@link WatchWorker}; this class no longer touches Flight directly.
 * Shared cross-task state (intraday sample buffers, MA-ref cache, per-
 * user hit buffers) lives on the worker because it owns those reads.
 *
 * Hit semantics: a fired evaluation is a *hit* iff **both** gates clear:
 *   - Price gate — `|last - lastHitPrice| / lastHitPrice >= 2 %`, OR
 *     `lastHitPrice == null` (first hit / new trading day).
 *   - Time gate — `now >= lastPushAt + pushIntervalSec*1000`, OR
 *     `lastPushAt == null`.
 *
 * `remaining` decrements on each fired hit; reaching zero auto-disables
 * the task. (Owned by `WatchWorker`.)
 */

import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { WatchMarket, WatchTask } from '@quant/shared';
import { UserStore } from '../auth/user.store.js';
import type { WatchJob } from './domain/watch-job.js';
import { isMarketOpen } from './domain/market-hours.js';
import type { InMemoryQueue } from '../orchestration/domain/in-memory-queue.js';
import { WatchGroupStore } from './watch-group.store.js';
import { WatchTaskStore } from './watch-task.store.js';
import { WatchWorker } from './watch-worker.js';
import { WATCH_QUEUE_A, WATCH_QUEUE_HK, WATCH_QUEUE_US } from './watch-tokens.js';

const MASTER_TICK_MS = 5_000;

@Injectable()
export class WatchScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WatchScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private destroyed = false;
  private tickInFlight: Promise<void> | null = null;

  constructor(
    @Inject(WatchTaskStore) private readonly store: WatchTaskStore,
    @Inject(WatchGroupStore) private readonly groups: WatchGroupStore,
    @Inject(UserStore) private readonly users: UserStore,
    @Inject(WatchWorker) private readonly worker: WatchWorker,
    @Inject(WATCH_QUEUE_A) private readonly queueA: InMemoryQueue<WatchJob>,
    @Inject(WATCH_QUEUE_HK) private readonly queueHk: InMemoryQueue<WatchJob>,
    @Inject(WATCH_QUEUE_US) private readonly queueUs: InMemoryQueue<WatchJob>,
  ) {}

  onModuleInit(): void {
    this.queueA.setProcessor(this.worker);
    this.queueHk.setProcessor(this.worker);
    this.queueUs.setProcessor(this.worker);
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
    await this.worker.shutdown();
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

    let pushed = 0;
    for (const user of this.users.list()) {
      const tasks = await this.store.snapshot(user.id);
      const groups = await this.groups.list(user.id);
      const disabledGroups = new Set<string>();
      for (const g of groups) if (!g.enabled) disabledGroups.add(g.name);
      for (const t of tasks) {
        if (disabledGroups.has(t.groupName)) continue;
        if (!this.isDue(t, marketsOpen, nowMs)) continue;
        const queue = this.queueFor(t.market);
        const id = `watch:${user.id}:${t.market}:${t.code}`;
        if (
          queue.add({ kind: 'watch_eval', userId: user.id, market: t.market, code: t.code }, { id })
        ) {
          pushed += 1;
        }
      }
    }
    if (pushed > 0) {
      this.logger.debug(`watch_tick_pushed jobs=${String(pushed)}`);
    }
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

  private queueFor(market: WatchMarket): InMemoryQueue<WatchJob> {
    switch (market) {
      case 'a':
        return this.queueA;
      case 'hk':
        return this.queueHk;
      case 'us':
        return this.queueUs;
    }
  }
}
