/**
 * Composition root for the stock-meta feature.
 *
 * NestJS reads the Python-written `data/stock_metas.parquet` directly
 * via DuckDB — see {@link LocalStockMetaAdapter}. The metrics columns
 * (post-kline-sync projection) are NestJS-owned end-to-end: Python's
 * compute-only Flight op returns the projected row and
 * {@link LocalStockMetaWriterService} writes it back to the same
 * parquet locally. Other meta columns (financials, list_date, …) are
 * still written by Python cron jobs; merging those is the next phase
 * of storage-unify-rollout.
 *
 * Both the read-only adapter and the writer share the same instance
 * (registered under both the token and the class) so writes can
 * invalidate the cache the adapter serves.
 */

import { Module } from '@nestjs/common';
import { SYSTEM_CLOCK_PROVIDER } from '../../common/clock.js';
import { STOCK_META_PORT } from './domain/stock-meta-port.js';
import { LocalStockMetaAdapter, STOCK_META_DATA_DIR } from './local-stock-meta.adapter.js';
import { LocalStockMetaWriterService } from './local-stock-meta-writer.service.js';
import { StockMetaController } from './stock-meta.controller.js';
import { StockMetaService } from './stock-meta.service.js';

const DEFAULT_DATA_DIR = '../../data';

@Module({
  controllers: [StockMetaController],
  providers: [
    {
      provide: STOCK_META_DATA_DIR,
      useFactory: (): string => process.env['QUANT_DATA_DIR'] ?? DEFAULT_DATA_DIR,
    },
    LocalStockMetaAdapter,
    { provide: STOCK_META_PORT, useExisting: LocalStockMetaAdapter },
    LocalStockMetaWriterService,
    SYSTEM_CLOCK_PROVIDER,
    StockMetaService,
    // `stock` (search) migrated to `BeInstructionCenter` (instruction-center/cells/stock.cell.ts).
  ],
  exports: [StockMetaService, LocalStockMetaWriterService],
})
export class StockMetaModule {}
