/**
 * Composition root for the kline read feature
 * (modules/02-stock-kline.md + 07 §4.2).
 *
 * Two storage paths live side-by-side during the storage-unify
 * rollout:
 *
 *   - **Local** — `DuckDBParquetTimeSeriesStore<KlineRow>` with the
 *     LSM main+delta layout from `docs/perf/kline-lsm-write.md`.
 *     Exposed via `KlineWriterService` (cron / scripts) and
 *     `KlineReaderService` (controllers / services).
 *   - **Flight** — legacy `list_kline_for_code` / `list_kline_bulk_last_n`
 *     ops on the Python service. Used by the controller while we
 *     ship the cross-process flip.
 *
 * Once `compute_kline_for_code` lands on the Python side, the Flight
 * channel becomes write-only (compute → push to NestJS writer); reads
 * stay entirely local.
 */

import { Module } from '@nestjs/common';

import { FlightClient } from '../../adapters/flight/flight-client.js';
import { DuckDBParquetTimeSeriesStore } from '../../common/storage/adapters/duckdb-parquet-time-series.store.js';
import type { TimeSeriesStore } from '../../common/storage/ports/time-series-store.port.js';
import { KlineController } from './kline.controller.js';
import { KlineReaderService } from './kline-reader.service.js';
import { KlineWriterService } from './kline-writer.service.js';
import { KLINE_COLUMNS, KLINE_TABLE_NAME, type KlineRow } from './kline.row.js';
import { KLINE_DATA_DIR, KLINE_FLIGHT_CLIENT, KLINE_TIME_SERIES_STORE } from './kline.token.js';

const DEFAULT_FLIGHT_TARGET = '127.0.0.1:8815';
const DEFAULT_DATA_DIR = '../../data';

@Module({
  controllers: [KlineController],
  providers: [
    {
      provide: KLINE_FLIGHT_CLIENT,
      useFactory: (): FlightClient => {
        const target = process.env['QUANT_FLIGHT_TARGET'] ?? DEFAULT_FLIGHT_TARGET;
        return new FlightClient(target);
      },
    },
    {
      provide: KLINE_DATA_DIR,
      useFactory: (): string => process.env['QUANT_DATA_ROOT'] ?? DEFAULT_DATA_DIR,
    },
    {
      provide: KLINE_TIME_SERIES_STORE,
      inject: [KLINE_DATA_DIR],
      useFactory: (dataRoot: string): TimeSeriesStore<KlineRow> =>
        new DuckDBParquetTimeSeriesStore({
          dataRoot,
          table: KLINE_TABLE_NAME,
          columns: KLINE_COLUMNS,
        }),
    },
    KlineWriterService,
    KlineReaderService,
  ],
  exports: [KlineWriterService, KlineReaderService, KLINE_TIME_SERIES_STORE],
})
export class KlineModule {}
