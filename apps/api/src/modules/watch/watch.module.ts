/**
 * Composition root for module W-0 watch.
 *
 * Owns:
 *   - the per-user task / group facades (delegating to the global
 *     `UserBlobStore` for `data/users/{uid}/user.parquet`)
 *   - the shared HK/US universe store
 *   - a Flight client (own channel — separate from stock-meta's so the
 *     two surfaces can be load-balanced independently in v2)
 *   - the master tick scheduler (`OnModuleInit`) — pure producer that
 *     pushes due tasks into per-market job queues
 *   - the per-market job queues + WatchWorker that drains them
 *   - the socket broadcaster that fans out per-user `watch.snapshot`
 */

import { Module } from '@nestjs/common';
import { FlightClient } from '../../adapters/flight/flight-client.js';
import { isPoolLevelError } from '../../adapters/flight/flight-errors.js';
import { ChannelModule } from '../channel/channel.module.js';
import { InMemoryQueue } from '../orchestration/domain/in-memory-queue.js';
import { StockListModule } from '../stock-list/stock-list.module.js';
import { StockMetaModule } from '../stock-meta/stock-meta.module.js';
import { KlineModule } from '../kline/kline.module.js';
import type { WatchJob } from './domain/watch-job.js';
import { WATCH_KLINE_REF_PORT, WATCH_QUOTE_PORT } from './domain/watch-port.js';
import { LocalKlineRefAdapter } from './local-kline-ref.adapter.js';
import { FlightWatchAdapter, WATCH_FLIGHT_CLIENT } from './flight-watch.adapter.js';
import { WatchGroupStore } from './watch-group.store.js';
import { WatchTaskStore } from './watch-task.store.js';
import { WatchUniverseStore } from './watch-universe.store.js';
import { WatchBroadcaster } from './watch.broadcaster.js';
import { WatchController } from './watch.controller.js';
import { WatchScheduler } from './watch.scheduler.js';
import { WatchService } from './watch.service.js';
import { WatchWorker } from './watch-worker.js';
import { WATCH_QUEUE_A, WATCH_QUEUE_HK, WATCH_QUEUE_US } from './watch-tokens.js';

const DEFAULT_FLIGHT_TARGET = '127.0.0.1:8815';

type MarketQueueTuning = {
  /**
   * Max simultaneously in-flight quote fetches for this market.
   *
   * Yahoo (yfinance backend, US) aggressively rate-limits parallel
   * connections from the same IP regardless of TLS impersonation — 1
   * serialised request per tick keeps us inside the limit. East Money
   * (akshare, A/HK) handles 8-way fan-out fine.
   */
  concurrency: number;
  /**
   * Base cooldown when the queue trips a pool-class error. Yahoo's
   * rate-limit window is minutes, so US bumps this from the default
   * 3s to 30s; A/HK keep 3s because their failures are typically
   * transient proxy hiccups.
   */
  poolBaseMs: number;
};

const makeMarketQueue = (
  name: string,
  tuning: MarketQueueTuning,
): InMemoryQueue<WatchJob> =>
  new InMemoryQueue<WatchJob>({
    name,
    concurrency: tuning.concurrency,
    maxRetry: 3,
    taskBackoff: {
      baseMs: 1_000,
      factor: 2,
      maxMs: 30_000,
      jitterRatio: 0.2,
    },
    poolBackoff: {
      baseMs: tuning.poolBaseMs,
      factor: 2,
      maxMs: 60_000,
      jitterRatio: 0.2,
      isPoolError: isPoolLevelError,
    },
  });

const A_HK_TUNING: MarketQueueTuning = { concurrency: 8, poolBaseMs: 3_000 };
const US_TUNING: MarketQueueTuning = { concurrency: 1, poolBaseMs: 30_000 };

@Module({
  imports: [StockMetaModule, StockListModule, ChannelModule, KlineModule],
  controllers: [WatchController],
  providers: [
    {
      provide: WATCH_FLIGHT_CLIENT,
      useFactory: (): FlightClient => {
        const target = process.env['QUANT_FLIGHT_TARGET'] ?? DEFAULT_FLIGHT_TARGET;
        return new FlightClient(target);
      },
    },
    { provide: WATCH_QUOTE_PORT, useClass: FlightWatchAdapter },
    { provide: WATCH_KLINE_REF_PORT, useClass: LocalKlineRefAdapter },
    {
      provide: WATCH_QUEUE_A,
      useFactory: (): InMemoryQueue<WatchJob> => makeMarketQueue('watch-a', A_HK_TUNING),
    },
    {
      provide: WATCH_QUEUE_HK,
      useFactory: (): InMemoryQueue<WatchJob> => makeMarketQueue('watch-hk', A_HK_TUNING),
    },
    {
      provide: WATCH_QUEUE_US,
      useFactory: (): InMemoryQueue<WatchJob> => makeMarketQueue('watch-us', US_TUNING),
    },
    WatchTaskStore,
    WatchGroupStore,
    WatchUniverseStore,
    WatchService,
    WatchWorker,
    WatchScheduler,
    WatchBroadcaster,
    // `watch` / `watch.add` / `watch.remove` / `watch.group` migrated to
    // `BeInstructionCenter` (instruction-center/cells/watch*.cell.ts).
  ],
  exports: [WatchService, WatchScheduler, WatchTaskStore],
})
export class WatchModule {}
