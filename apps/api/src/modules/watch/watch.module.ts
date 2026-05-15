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
import { WatchAddInstructionHandler } from './instructions/watch-add.handler.js';
import { WatchGroupInstructionHandler } from './instructions/watch-group.handler.js';
import { WatchInstructionHandler } from './instructions/watch.handler.js';
import { WatchRemoveInstructionHandler } from './instructions/watch-remove.handler.js';
import { WatchBroadcaster } from './watch.broadcaster.js';
import { WatchController } from './watch.controller.js';
import { WatchScheduler } from './watch.scheduler.js';
import { WatchService } from './watch.service.js';
import { WatchWorker } from './watch-worker.js';
import { WATCH_QUEUE_A, WATCH_QUEUE_HK, WATCH_QUEUE_US } from './watch-tokens.js';

const DEFAULT_FLIGHT_TARGET = '127.0.0.1:8815';

const makeMarketQueue = (name: string): InMemoryQueue<WatchJob> =>
  new InMemoryQueue<WatchJob>({
    name,
    concurrency: 8,
    maxRetry: 3,
    taskBackoff: {
      baseMs: 1_000,
      factor: 2,
      maxMs: 30_000,
      jitterRatio: 0.2,
    },
    poolBackoff: {
      baseMs: 3_000,
      factor: 2,
      maxMs: 30_000,
      jitterRatio: 0.2,
      isPoolError: isPoolLevelError,
    },
  });

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
      useFactory: (): InMemoryQueue<WatchJob> => makeMarketQueue('watch-a'),
    },
    {
      provide: WATCH_QUEUE_HK,
      useFactory: (): InMemoryQueue<WatchJob> => makeMarketQueue('watch-hk'),
    },
    {
      provide: WATCH_QUEUE_US,
      useFactory: (): InMemoryQueue<WatchJob> => makeMarketQueue('watch-us'),
    },
    WatchTaskStore,
    WatchGroupStore,
    WatchUniverseStore,
    WatchService,
    WatchWorker,
    WatchScheduler,
    WatchBroadcaster,
    WatchInstructionHandler,
    WatchAddInstructionHandler,
    WatchRemoveInstructionHandler,
    WatchGroupInstructionHandler,
  ],
  exports: [WatchService, WatchScheduler],
})
export class WatchModule {}
