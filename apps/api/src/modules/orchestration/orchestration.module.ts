/**
 * Composition root for the update-orchestration feature
 * (`docs/modules/09-update-orchestration.md`).
 *
 * - One Flight client (separate channel from stock-meta's, same target)
 *   used by inspector + workers.
 * - Two `InMemoryQueue` instances: meta + kline, parametrised by
 *   `ServerConfigCenter.orchestration.queues.*` so the curves are
 *   env-tunable in prod without redeploying.
 * - `BatchSettler` subscribes to both queues' terminal events to run
 *   blacklist + dynamic-sectors recompute as the 16:00 tail-off.
 * - Workers attach to their queue via `OnModuleInit` — wiring after DI
 *   resolves so the queue does not start pulling before the processor
 *   exists.
 */

import { Inject, Module, type OnModuleInit } from '@nestjs/common';
import { ServerConfigCenter } from '@quant/config/server';
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

@Module({
  imports: [BlacklistModule, KlineModule, SectorsModule, StockMetaModule],
  controllers: [QueueStatusController],
  providers: [
    {
      provide: ORCH_FLIGHT_CLIENT,
      useFactory: (): FlightClient => {
        const target = ServerConfigCenter.get().flight.target;
        return new FlightClient(target);
      },
    },
    {
      provide: META_QUEUE,
      useFactory: (): InMemoryQueue<MetaJob> => {
        const meta = ServerConfigCenter.get().orchestration.queues.meta;
        return new InMemoryQueue<MetaJob>({
          name: 'meta',
          concurrency: meta.concurrency,
          maxRetry: meta.maxRetry,
          taskBackoff: { ...meta.taskBackoff },
          poolBackoff: {
            ...meta.poolBackoff,
            isPoolError: isPoolLevelError,
          },
        });
      },
    },
    {
      provide: KLINE_QUEUE,
      useFactory: (): InMemoryQueue<KlineJob> => {
        const kline = ServerConfigCenter.get().orchestration.queues.kline;
        return new InMemoryQueue<KlineJob>({
          name: 'kline',
          concurrency: kline.concurrency,
          maxRetry: kline.maxRetry,
          taskBackoff: { ...kline.taskBackoff },
          poolBackoff: {
            ...kline.poolBackoff,
            isPoolError: isPoolLevelError,
          },
        });
      },
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
    void this._settler;
  }
}
