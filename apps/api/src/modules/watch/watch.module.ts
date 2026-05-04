/**
 * Composition root for module W-0 watch.
 *
 * Owns:
 *   - the file-backed task store and HK/US universe stores
 *   - a Flight client (own channel — separate from stock-meta's so the
 *     two surfaces can be load-balanced independently in v2)
 *   - a Slack-webhook notifier (env: ``QUANT_WATCH_SLACK_WEBHOOK``)
 *   - the master tick scheduler (`OnModuleInit`)
 */

import { Module } from '@nestjs/common';
import { FlightClient } from '../../adapters/flight/flight-client.js';
import { StockMetaModule } from '../stock-meta/stock-meta.module.js';
import { WATCH_QUOTE_PORT } from './domain/watch-port.js';
import { FlightWatchAdapter, WATCH_FLIGHT_CLIENT } from './flight-watch.adapter.js';
import { SlackWebhookWatchNotifier, WATCH_NOTIFIER, type WatchNotifier } from './watch-notifier.js';
import { WATCH_DATA_DIR, WatchTaskStore } from './watch-task.store.js';
import { WatchUniverseStore } from './watch-universe.store.js';
import { WatchController } from './watch.controller.js';
import { WatchScheduler } from './watch.scheduler.js';
import { WatchService } from './watch.service.js';

const DEFAULT_FLIGHT_TARGET = '127.0.0.1:8815';
// Repo-root `data/watch` (Nest cwd is `apps/api`, so two-up).
// HK/US universe JSON lives here and is checked into git so a fresh
// clone has the lookup tables ready without an akshare round-trip.
const DEFAULT_DATA_DIR = '../../data/watch';

@Module({
  imports: [StockMetaModule],
  controllers: [WatchController],
  providers: [
    {
      provide: WATCH_FLIGHT_CLIENT,
      useFactory: (): FlightClient => {
        const target = process.env['QUANT_FLIGHT_TARGET'] ?? DEFAULT_FLIGHT_TARGET;
        return new FlightClient(target);
      },
    },
    {
      provide: WATCH_DATA_DIR,
      useFactory: (): string => process.env['QUANT_WATCH_DIR'] ?? DEFAULT_DATA_DIR,
    },
    {
      provide: WATCH_NOTIFIER,
      useFactory: (): WatchNotifier => {
        // Prefer the watch-specific override; fall back to the
        // project-wide `SLACK_WEBHOOK_URL` (the same one §08
        // NotificationService uses) so a single .env entry powers both.
        const url =
          process.env['QUANT_WATCH_SLACK_WEBHOOK'] ?? process.env['SLACK_WEBHOOK_URL'] ?? null;
        return new SlackWebhookWatchNotifier(url);
      },
    },
    { provide: WATCH_QUOTE_PORT, useClass: FlightWatchAdapter },
    WatchTaskStore,
    WatchUniverseStore,
    WatchService,
    WatchScheduler,
  ],
  exports: [WatchService, WatchScheduler],
})
export class WatchModule {}
