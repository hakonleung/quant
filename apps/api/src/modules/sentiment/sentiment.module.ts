/**
 * Composition root for the sentiment feature (modules/05-sentiment.md).
 *
 * The full pipeline (web-search analyst pass + JSON aggregator + theme
 * cluster + market synth + cache) runs in NestJS. The Python sentiment
 * service / Flight ops / parquet cache were retired with the migration;
 * the only Python touchpoint left for sentiment is `StockMetaService`,
 * which is read-only.
 */

import { Module } from '@nestjs/common';

import { SYSTEM_CLOCK_PROVIDER } from '../../common/clock.js';
import { DuckDBParquetRecordStore } from '../../common/storage/adapters/duckdb-parquet-record.store.js';
import type { RecordStore } from '../../common/storage/ports/record-store.port.js';
import { LlmModule } from '../llm/llm.module.js';
import { SectorsModule } from '../sectors/sectors.module.js';
import { StockMetaModule } from '../stock-meta/stock-meta.module.js';
import { AnalyzeInstructionHandler } from './instructions/analyze.handler.js';
import { AnalyzeSectorInstructionHandler } from './instructions/analyze-sector.handler.js';
import { NewsSentimentService } from './news-sentiment.service.js';
import {
  SENTIMENT_MARKET_TABLE_SPEC,
  SENTIMENT_STOCK_TABLE_SPEC,
  SentimentCacheStore,
  type SentimentMarketRow,
  type SentimentStockRow,
} from './sentiment-cache.store.js';
import { SentimentController } from './sentiment.controller.js';
import {
  SENTIMENT_DATA_DIR,
  SENTIMENT_MARKET_RECORD_STORE,
  SENTIMENT_STOCK_RECORD_STORE,
} from './sentiment.token.js';

const DEFAULT_DATA_DIR = '../../data';

@Module({
  imports: [LlmModule, StockMetaModule, SectorsModule],
  controllers: [SentimentController],
  providers: [
    {
      provide: SENTIMENT_DATA_DIR,
      useFactory: (): string => process.env['QUANT_DATA_ROOT'] ?? DEFAULT_DATA_DIR,
    },
    {
      provide: SENTIMENT_STOCK_RECORD_STORE,
      inject: [SENTIMENT_DATA_DIR],
      useFactory: (dataRoot: string): RecordStore<SentimentStockRow> =>
        new DuckDBParquetRecordStore<SentimentStockRow>({
          dataRoot,
          spec: SENTIMENT_STOCK_TABLE_SPEC,
        }),
    },
    {
      provide: SENTIMENT_MARKET_RECORD_STORE,
      inject: [SENTIMENT_DATA_DIR],
      useFactory: (dataRoot: string): RecordStore<SentimentMarketRow> =>
        new DuckDBParquetRecordStore<SentimentMarketRow>({
          dataRoot,
          spec: SENTIMENT_MARKET_TABLE_SPEC,
        }),
    },
    SYSTEM_CLOCK_PROVIDER,
    SentimentCacheStore,
    NewsSentimentService,
    AnalyzeInstructionHandler,
    AnalyzeSectorInstructionHandler,
  ],
})
export class SentimentModule {}
