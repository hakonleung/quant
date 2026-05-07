/**
 * Composition root for the update-orchestration feature
 * (`docs/modules/09-update-orchestration.md`).
 *
 * - One Flight client (separate channel from stock-meta's, same target)
 *   used by inspector + workers.
 * - Two `InMemoryQueue` instances (meta: concurrency 1; kline: 4).
 * - Workers attach to their queue via `OnModuleInit` — wiring after DI
 *   resolves so the queue does not start pulling before the processor
 *   exists.
 */

import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { FlightClient } from '../../adapters/flight/flight-client.js';
import { BlacklistModule } from '../blacklist/blacklist.module.js';
import { CacheInspector } from './cache-inspector.js';
import { CronOrchestrator } from './cron.orchestrator.js';
import { InMemoryQueue } from './domain/in-memory-queue.js';
import { KLINE_QUEUE, META_QUEUE, ORCH_FLIGHT_CLIENT } from './flight.token.js';
import { KlineWorker } from './kline-worker.js';
import { MetaWorker } from './meta-worker.js';
import { QueueBroadcaster } from './queue.broadcaster.js';
import { QueueStatusController } from './queue-status.controller.js';
import type { KlineJob, MetaJob } from './domain/types.js';

const DEFAULT_FLIGHT_TARGET = '127.0.0.1:8815';

@Module({
  imports: [BlacklistModule],
  controllers: [QueueStatusController],
  providers: [
    {
      provide: ORCH_FLIGHT_CLIENT,
      useFactory: (): FlightClient => {
        const target = process.env['QUANT_FLIGHT_TARGET'] ?? DEFAULT_FLIGHT_TARGET;
        return new FlightClient(target);
      },
    },
    {
      provide: META_QUEUE,
      useFactory: (): InMemoryQueue<MetaJob> =>
        new InMemoryQueue<MetaJob>({ name: 'meta', concurrency: 1 }),
    },
    {
      provide: KLINE_QUEUE,
      useFactory: (): InMemoryQueue<KlineJob> =>
        new InMemoryQueue<KlineJob>({ name: 'kline', concurrency: 4 }),
    },
    CacheInspector,
    MetaWorker,
    KlineWorker,
    CronOrchestrator,
    QueueBroadcaster,
  ],
  exports: [META_QUEUE, KLINE_QUEUE],
})
export class OrchestrationModule implements OnModuleInit {
  constructor(
    @Inject(META_QUEUE) private readonly metaQueue: InMemoryQueue<MetaJob>,
    @Inject(KLINE_QUEUE) private readonly klineQueue: InMemoryQueue<KlineJob>,
    @Inject(MetaWorker) private readonly metaWorker: MetaWorker,
    @Inject(KlineWorker) private readonly klineWorker: KlineWorker,
  ) {}

  onModuleInit(): void {
    this.metaQueue.setProcessor(this.metaWorker);
    this.klineQueue.setProcessor(this.klineWorker);
  }
}
