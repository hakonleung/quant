/**
 * Composition root for module W-0 watch.
 *
 * Owns:
 *   - the per-user task / group stores (via `UserScopedJsonStore`)
 *   - the shared HK/US universe store
 *   - a Flight client (own channel — separate from stock-meta's so the
 *     two surfaces can be load-balanced independently in v2)
 *   - the master tick scheduler (`OnModuleInit`) — iterates all known users
 *   - the socket broadcaster that fans out per-user `watch.snapshot`
 */

import { Module } from '@nestjs/common';
import { FlightClient } from '../../adapters/flight/flight-client.js';
import { ChannelModule } from '../channel/channel.module.js';
import { StockMetaModule } from '../stock-meta/stock-meta.module.js';
import { WATCH_KLINE_REF_PORT, WATCH_QUOTE_PORT } from './domain/watch-port.js';
import { FlightKlineRefAdapter } from './flight-kline-ref.adapter.js';
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

const DEFAULT_FLIGHT_TARGET = '127.0.0.1:8815';

@Module({
  imports: [StockMetaModule, ChannelModule],
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
    { provide: WATCH_KLINE_REF_PORT, useClass: FlightKlineRefAdapter },
    WatchTaskStore,
    WatchGroupStore,
    WatchUniverseStore,
    WatchService,
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
