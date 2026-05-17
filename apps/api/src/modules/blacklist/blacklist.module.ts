import { Module } from '@nestjs/common';

import { SYSTEM_CLOCK_PROVIDER } from '../../common/clock.js';
import { DuckDBParquetRecordStore } from '../../common/storage/adapters/duckdb-parquet-record.store.js';
import type { RecordStore } from '../../common/storage/ports/record-store.port.js';
import { StockMetaModule } from '../stock-meta/stock-meta.module.js';
import { BlacklistController } from './blacklist.controller.js';
import { BlacklistService } from './blacklist.service.js';
import { BLACKLIST_TABLE_SPEC, BlacklistStore, type BlacklistRow } from './blacklist.store.js';
import { BLACKLIST_DATA_DIR, BLACKLIST_RECORD_STORE } from './blacklist.token.js';
const DEFAULT_DATA_DIR = '../../data';

@Module({
  imports: [StockMetaModule],
  controllers: [BlacklistController],
  providers: [
    {
      provide: BLACKLIST_DATA_DIR,
      useFactory: (): string => process.env['QUANT_BLACKLIST_DIR'] ?? DEFAULT_DATA_DIR,
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
