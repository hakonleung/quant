/**
 * Composition root for screen-signal backtesting. Owns its own Flight
 * channel so a long evaluate run does not head-of-line block other
 * Python-bound traffic (pattern, blacklist, financials).
 *
 * Cache wiring: two RecordStores under `data/cache/` (parquet rewrite
 * per upsert, same pattern as `SectorsStore`). Invalidation is by
 * `last_trade_day` equality, not TTL — see `backtest-cache.store.ts`.
 */

import { Module } from '@nestjs/common';

import { FlightClient } from '../../adapters/flight/flight-client.js';
import { DuckDBParquetRecordStore } from '../../common/storage/adapters/duckdb-parquet-record.store.js';
import type { RecordStore } from '../../common/storage/ports/record-store.port.js';
import { KlineModule } from '../kline/kline.module.js';
import { KLINE_DATA_DIR } from '../kline/kline.token.js';
import { ScreenModule } from '../screen/screen.module.js';
import {
  BACKTEST_BASELINE_CACHE_SPEC,
  BACKTEST_BASELINE_CACHE_STORE,
  BACKTEST_RESPONSE_CACHE_SPEC,
  BACKTEST_RESPONSE_CACHE_STORE,
  BACKTEST_SCREEN_CACHE_SPEC,
  BACKTEST_SCREEN_CACHE_STORE,
  BacktestCacheStore,
  type BaselineCacheRow,
  type ResponseCacheRow,
  type ScreenCacheRow,
} from './backtest-cache.store.js';
import { BacktestController } from './backtest.controller.js';
import { BacktestService } from './backtest.service.js';
import { BACKTEST_FLIGHT_CLIENT } from './backtest.token.js';

const DEFAULT_FLIGHT_TARGET = '127.0.0.1:8815';

@Module({
  imports: [KlineModule, ScreenModule],
  controllers: [BacktestController],
  providers: [
    BacktestService,
    BacktestCacheStore,
    {
      provide: BACKTEST_FLIGHT_CLIENT,
      useFactory: (): FlightClient => {
        const target = process.env['QUANT_FLIGHT_TARGET'] ?? DEFAULT_FLIGHT_TARGET;
        return new FlightClient(target);
      },
    },
    {
      provide: BACKTEST_SCREEN_CACHE_STORE,
      inject: [KLINE_DATA_DIR],
      useFactory: (klineDataRoot: string): RecordStore<ScreenCacheRow> =>
        new DuckDBParquetRecordStore<ScreenCacheRow>({
          dataRoot: cacheDataRoot(klineDataRoot),
          spec: BACKTEST_SCREEN_CACHE_SPEC,
        }),
    },
    {
      provide: BACKTEST_BASELINE_CACHE_STORE,
      inject: [KLINE_DATA_DIR],
      useFactory: (klineDataRoot: string): RecordStore<BaselineCacheRow> =>
        new DuckDBParquetRecordStore<BaselineCacheRow>({
          dataRoot: cacheDataRoot(klineDataRoot),
          spec: BACKTEST_BASELINE_CACHE_SPEC,
        }),
    },
    {
      provide: BACKTEST_RESPONSE_CACHE_STORE,
      inject: [KLINE_DATA_DIR],
      useFactory: (klineDataRoot: string): RecordStore<ResponseCacheRow> =>
        new DuckDBParquetRecordStore<ResponseCacheRow>({
          dataRoot: cacheDataRoot(klineDataRoot),
          spec: BACKTEST_RESPONSE_CACHE_SPEC,
        }),
    },
  ],
  exports: [BacktestService],
})
export class BacktestModule {}

/**
 * Co-locate the cache parquet next to the existing `data/kline/` (one
 * level up = the canonical data root). Putting it under `data/cache/`
 * keeps cache files distinct from durable domain data and makes them
 * safe to delete wholesale.
 */
function cacheDataRoot(klineDataRoot: string): string {
  return `${klineDataRoot}/cache`;
}
