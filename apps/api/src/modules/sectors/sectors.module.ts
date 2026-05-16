import { Module } from '@nestjs/common';

import { SYSTEM_CLOCK_PROVIDER } from '../../common/clock.js';
import { DuckDBParquetRecordStore } from '../../common/storage/adapters/duckdb-parquet-record.store.js';
import type { RecordStore } from '../../common/storage/ports/record-store.port.js';
import { ScreenModule } from '../screen/screen.module.js';
import { StockListModule } from '../stock-list/stock-list.module.js';
import { StockMetaModule } from '../stock-meta/stock-meta.module.js';
import { SectorRefreshInstructionHandler } from './instructions/sector-refresh.handler.js';
import { SectorsController } from './sectors.controller.js';
import { SectorsService } from './sectors.service.js';
import {
  SECTORS_DATA_DIR,
  SECTORS_RECORD_STORE,
  SECTORS_TABLE_SPEC,
  SectorsStore,
  type SectorRow,
} from './sectors.store.js';

const DEFAULT_DATA_DIR = '../../data';

@Module({
  imports: [StockMetaModule, StockListModule, ScreenModule],
  controllers: [SectorsController],
  providers: [
    {
      provide: SECTORS_DATA_DIR,
      useFactory: (): string => process.env['QUANT_SECTORS_DIR'] ?? DEFAULT_DATA_DIR,
    },
    {
      provide: SECTORS_RECORD_STORE,
      inject: [SECTORS_DATA_DIR],
      useFactory: (dataRoot: string): RecordStore<SectorRow> =>
        new DuckDBParquetRecordStore<SectorRow>({
          dataRoot,
          spec: SECTORS_TABLE_SPEC,
        }),
    },
    SYSTEM_CLOCK_PROVIDER,
    SectorsStore,
    SectorsService,
    // `sector` (list/show) + `sector.publish` / `sector.unpublish` / `sector.rm`
    // migrated to `BeInstructionCenter` (instruction-center/cells/sector*.cell.ts).
    SectorRefreshInstructionHandler,
  ],
  exports: [SectorsStore, SectorsService],
})
export class SectorsModule {}
