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

import { Logger, Module } from '@nestjs/common';
import { FlightClient } from '../../adapters/flight/flight-client.js';
import type { UserScopedRecordStore } from '../../common/storage/ports/user-scoped-record-store.port.js';
import { AUTH_CONFIG, type AuthConfigShape } from '../auth/config/auth.config.js';
import { ChannelModule } from '../channel/channel.module.js';
import { StockMetaModule } from '../stock-meta/stock-meta.module.js';
import { WATCH_KLINE_REF_PORT, WATCH_QUOTE_PORT } from './domain/watch-port.js';
import { FlightKlineRefAdapter } from './flight-kline-ref.adapter.js';
import { FlightWatchAdapter, WATCH_FLIGHT_CLIENT } from './flight-watch.adapter.js';
import {
  buildWatchGroupUserScopedStore,
  WatchGroupStore,
  type WatchGroupRow,
} from './watch-group.store.js';
import {
  buildWatchTaskUserScopedStore,
  WatchTaskStore,
  type WatchTaskRow,
} from './watch-task.store.js';
import {
  WATCH_GROUP_USER_RECORD_STORE,
  WATCH_TASK_USER_RECORD_STORE,
} from './watch.tokens.js';
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
    {
      provide: WATCH_TASK_USER_RECORD_STORE,
      inject: [AUTH_CONFIG],
      useFactory: (cfg: AuthConfigShape): UserScopedRecordStore<WatchTaskRow> =>
        buildWatchTaskUserScopedStore(cfg, new Logger(WatchTaskStore.name)),
    },
    {
      provide: WATCH_GROUP_USER_RECORD_STORE,
      inject: [AUTH_CONFIG],
      useFactory: (cfg: AuthConfigShape): UserScopedRecordStore<WatchGroupRow> =>
        buildWatchGroupUserScopedStore(cfg, new Logger(WatchGroupStore.name)),
    },
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
