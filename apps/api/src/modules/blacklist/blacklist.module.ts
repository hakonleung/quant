import { Module } from '@nestjs/common';

import { FlightClient } from '../../adapters/flight/flight-client.js';
import { SYSTEM_CLOCK_PROVIDER } from '../../common/clock.js';
import { DuckDBParquetRecordStore } from '../../common/storage/adapters/duckdb-parquet-record.store.js';
import type { RecordStore } from '../../common/storage/ports/record-store.port.js';
import { BlacklistController } from './blacklist.controller.js';
import { BlacklistService } from './blacklist.service.js';
import { BLACKLIST_TABLE_SPEC, BlacklistStore, type BlacklistRow } from './blacklist.store.js';
import {
  BLACKLIST_DATA_DIR,
  BLACKLIST_FLIGHT_CLIENT,
  BLACKLIST_RECORD_STORE,
} from './blacklist.token.js';
const DEFAULT_DATA_DIR = '../../data';
const DEFAULT_FLIGHT_TARGET = '127.0.0.1:8815';

@Module({
  controllers: [BlacklistController],
  providers: [
    {
      provide: BLACKLIST_DATA_DIR,
      useFactory: (): string => process.env['QUANT_BLACKLIST_DIR'] ?? DEFAULT_DATA_DIR,
    },
    {
      provide: BLACKLIST_FLIGHT_CLIENT,
      useFactory: (): FlightClient => {
        const target = process.env['QUANT_FLIGHT_TARGET'] ?? DEFAULT_FLIGHT_TARGET;
        return new FlightClient(target);
      },
    },
    {
      provide: BLACKLIST_RECORD_STORE,
      inject: [BLACKLIST_DATA_DIR],
      useFactory: (dataRoot: string): RecordStore<BlacklistRow> =>
        new DuckDBParquetRecordStore<BlacklistRow>({
          dataRoot,
          spec: BLACKLIST_TABLE_SPEC,
        }),
    },
    SYSTEM_CLOCK_PROVIDER,
    BlacklistStore,
    BlacklistService,
  ],
  exports: [BlacklistStore, BlacklistService],
})
export class BlacklistModule {}
