/**
 * Composition root for the update-orchestration feature
 * (`docs/modules/09-update-orchestration.md`).
 *
 * - One Flight client (separate channel from stock-meta's, same target)
 *   used by inspector + workers.
 * - Two `InMemoryQueue` instances:
 *   - meta:  concurrency 8, maxRetry 3, taskBackoff 1s→5min, poolBackoff 5s→5min
 *   - kline: concurrency 8, maxRetry 3, taskBackoff 5s→15min, poolBackoff 5s→5min
 * - `BatchSettler` subscribes to both queues' terminal events to run
 *   blacklist + dynamic-sectors recompute as the 16:00 tail-off.
 * - Workers attach to their queue via `OnModuleInit` — wiring after DI
 *   resolves so the queue does not start pulling before the processor
 *   exists.
 */

import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { FlightClient } from '../../adapters/flight/flight-client.js';
import { isPoolLevelError } from '../../adapters/flight/flight-errors.js';
import { BlacklistModule } from '../blacklist/blacklist.module.js';
import { KlineModule } from '../kline/kline.module.js';
import { SectorsModule } from '../sectors/sectors.module.js';
import { StockMetaModule } from '../stock-meta/stock-meta.module.js';
import { BatchSettler } from './batch-settler.js';
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
  imports: [BlacklistModule, KlineModule, SectorsModule, StockMetaModule],
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
        new InMemoryQueue<MetaJob>({
          name: 'meta',
          concurrency: 8,
          maxRetry: 3,
          taskBackoff: {
            baseMs: 1_000,
            factor: 2,
            maxMs: 5 * 60_000,
            jitterRatio: 0.2,
          },
          poolBackoff: {
            baseMs: 5_000,
            factor: 2,
            maxMs: 5 * 60_000,
            jitterRatio: 0.2,
            isPoolError: isPoolLevelError,
          },
        }),
    },
    {
      provide: KLINE_QUEUE,
      useFactory: (): InMemoryQueue<KlineJob> =>
        new InMemoryQueue<KlineJob>({
          name: 'kline',
          concurrency: 8,
          maxRetry: 3,
          taskBackoff: {
            baseMs: 5_000,
            factor: 2,
            maxMs: 15 * 60_000,
            jitterRatio: 0.2,
          },
          poolBackoff: {
            baseMs: 5_000,
            factor: 2,
            maxMs: 5 * 60_000,
            jitterRatio: 0.2,
            isPoolError: isPoolLevelError,
          },
        }),
    },
    CacheInspector,
    MetaWorker,
    KlineWorker,
    BatchSettler,
    CronOrchestrator,
    QueueBroadcaster,
    // `update` migrated to `BeInstructionCenter` (instruction-center/cells/update.cell.ts).
  ],
  exports: [META_QUEUE, KLINE_QUEUE, CronOrchestrator],
})
export class OrchestrationModule implements OnModuleInit {
  constructor(
    @Inject(META_QUEUE) private readonly metaQueue: InMemoryQueue<MetaJob>,
    @Inject(KLINE_QUEUE) private readonly klineQueue: InMemoryQueue<KlineJob>,
    @Inject(MetaWorker) private readonly metaWorker: MetaWorker,
    @Inject(KlineWorker) private readonly klineWorker: KlineWorker,
    @Inject(BatchSettler) private readonly _settler: BatchSettler,
  ) {}

  onModuleInit(): void {
    this.metaQueue.setProcessor(this.metaWorker);
    this.klineQueue.setProcessor(this.klineWorker);
    // Touch the settler so Nest instantiates it eagerly — its
    // constructor wires terminal listeners onto both queues.
    void this._settler;
  }
}
