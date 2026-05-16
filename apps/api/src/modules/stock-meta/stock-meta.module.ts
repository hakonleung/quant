/**
 * Composition root for the stock-meta feature.
 *
 * NestJS reads the Python-written `data/stock_metas.parquet` directly
 * via DuckDB — see {@link LocalStockMetaAdapter}. Python remains the
 * sole writer (post-kline-sync projector). The Flight round-trip was
 * retired in favour of an in-process DuckDB scan with a 60s SWR cache;
 * the historical `FlightStockMetaAdapter` is gone with it.
 */

import { Module } from '@nestjs/common';
import { SYSTEM_CLOCK_PROVIDER } from '../../common/clock.js';
import { STOCK_META_PORT } from './domain/stock-meta-port.js';
import { LocalStockMetaAdapter, STOCK_META_DATA_DIR } from './local-stock-meta.adapter.js';
import { StockInstructionHandler } from './instructions/stock.handler.js';
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
    { provide: STOCK_META_PORT, useClass: LocalStockMetaAdapter },
    SYSTEM_CLOCK_PROVIDER,
    StockMetaService,
    StockInstructionHandler,
  ],
  exports: [StockMetaService],
})
export class StockMetaModule {}
