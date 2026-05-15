/**
 * Composition root for the technical-analysis (beta) feature.
 *
 * Owns its own Flight channel — separate from sentiment / kline — so a
 * long-running Kimi call doesn't block other reads. Imports `LlmModule`
 * for the per-stock + sector-level LLM calls and `StockMetaModule` for
 * the meta lookup the prompt embeds. The Python TA service is gone —
 * full pipeline (kline read + prompt + LLM + cache) runs locally.
 */

import { Module } from '@nestjs/common';

import { SYSTEM_CLOCK_PROVIDER } from '../../common/clock.js';
import { DuckDBParquetRecordStore } from '../../common/storage/adapters/duckdb-parquet-record.store.js';
import type { RecordStore } from '../../common/storage/ports/record-store.port.js';
import { KlineModule } from '../kline/kline.module.js';
import { LlmModule } from '../llm/llm.module.js';
import { SectorsModule } from '../sectors/sectors.module.js';
import { StockMetaModule } from '../stock-meta/stock-meta.module.js';
import {
  TA_CACHE_TABLE_SPEC,
  TaCacheStore,
  type TaCacheRow,
} from './ta-cache.store.js';
import { TaController } from './ta.controller.js';
import { TaInstructionHandler } from './instructions/ta.handler.js';
import { TaSectorInstructionHandler } from './instructions/ta-sector.handler.js';
import { TaService } from './ta.service.js';
import { TA_CACHE_RECORD_STORE, TA_DATA_DIR } from './ta.token.js';

const DEFAULT_DATA_DIR = '../../data';

@Module({
  imports: [LlmModule, StockMetaModule, SectorsModule, KlineModule],
  controllers: [TaController],
  providers: [
    {
      provide: TA_DATA_DIR,
      useFactory: (): string => process.env['QUANT_DATA_ROOT'] ?? DEFAULT_DATA_DIR,
    },
    {
      provide: TA_CACHE_RECORD_STORE,
      inject: [TA_DATA_DIR],
      useFactory: (dataRoot: string): RecordStore<TaCacheRow> =>
        new DuckDBParquetRecordStore<TaCacheRow>({
          dataRoot,
          spec: TA_CACHE_TABLE_SPEC,
        }),
    },
    SYSTEM_CLOCK_PROVIDER,
    TaCacheStore,
    TaService,
    TaInstructionHandler,
    TaSectorInstructionHandler,
  ],
})
export class TaModule {}
