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

import { FlightClient } from '../../adapters/flight/flight-client.js';
import { SYSTEM_CLOCK_PROVIDER } from '../../common/clock.js';
import { LlmModule } from '../llm/llm.module.js';
import { SectorsModule } from '../sectors/sectors.module.js';
import { StockMetaModule } from '../stock-meta/stock-meta.module.js';
import { TaCacheStore } from './ta-cache.store.js';
import { TaController } from './ta.controller.js';
import { TaInstructionHandler } from './instructions/ta.handler.js';
import { TaSectorInstructionHandler } from './instructions/ta-sector.handler.js';
import { TaService } from './ta.service.js';
import { TA_DATA_DIR, TA_FLIGHT_CLIENT } from './ta.token.js';

const DEFAULT_FLIGHT_TARGET = '127.0.0.1:8815';
const DEFAULT_DATA_DIR = '../../data';

@Module({
  imports: [LlmModule, StockMetaModule, SectorsModule],
  controllers: [TaController],
  providers: [
    {
      provide: TA_FLIGHT_CLIENT,
      useFactory: (): FlightClient => {
        const target = process.env['QUANT_FLIGHT_TARGET'] ?? DEFAULT_FLIGHT_TARGET;
        return new FlightClient(target);
      },
    },
    {
      provide: TA_DATA_DIR,
      useFactory: (): string => process.env['QUANT_DATA_ROOT'] ?? DEFAULT_DATA_DIR,
    },
    SYSTEM_CLOCK_PROVIDER,
    TaCacheStore,
    TaService,
    TaInstructionHandler,
    TaSectorInstructionHandler,
  ],
})
export class TaModule {}
