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
import { LlmModule } from '../llm/llm.module.js';
import { SectorsModule } from '../sectors/sectors.module.js';
import { StockMetaModule } from '../stock-meta/stock-meta.module.js';
import { AnalyzeInstructionHandler } from './instructions/analyze.handler.js';
import { AnalyzeSectorInstructionHandler } from './instructions/analyze-sector.handler.js';
import { NewsSentimentService } from './news-sentiment.service.js';
import { SentimentCacheStore } from './sentiment-cache.store.js';
import { SentimentController } from './sentiment.controller.js';
import { SENTIMENT_DATA_DIR } from './sentiment.token.js';

const DEFAULT_DATA_DIR = '../../data';

@Module({
  imports: [LlmModule, StockMetaModule, SectorsModule],
  controllers: [SentimentController],
  providers: [
    {
      provide: SENTIMENT_DATA_DIR,
      useFactory: (): string => process.env['QUANT_DATA_ROOT'] ?? DEFAULT_DATA_DIR,
    },
    SYSTEM_CLOCK_PROVIDER,
    SentimentCacheStore,
    NewsSentimentService,
    AnalyzeInstructionHandler,
    AnalyzeSectorInstructionHandler,
  ],
})
export class SentimentModule {}
