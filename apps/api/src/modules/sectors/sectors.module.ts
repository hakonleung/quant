import { Module } from '@nestjs/common';

import { FlightClient } from '../../adapters/flight/flight-client.js';
import { SYSTEM_CLOCK_PROVIDER } from '../../common/clock.js';
import { DuckDBParquetRecordStore } from '../../common/storage/adapters/duckdb-parquet-record.store.js';
import type { RecordStore } from '../../common/storage/ports/record-store.port.js';
import { StockMetaModule } from '../stock-meta/stock-meta.module.js';
import { SectorInstructionHandler } from './instructions/sector.handler.js';
import {
  SectorPublishInstructionHandler,
  SectorUnpublishInstructionHandler,
} from './instructions/sector-publish.handler.js';
import { SectorRefreshInstructionHandler } from './instructions/sector-refresh.handler.js';
import { SectorRmInstructionHandler } from './instructions/sector-rm.handler.js';
import { SectorShowInstructionHandler } from './instructions/sector-show.handler.js';
import { SectorsController } from './sectors.controller.js';
import { SectorsService } from './sectors.service.js';
import {
  SECTORS_DATA_DIR,
  SECTORS_RECORD_STORE,
  SECTORS_TABLE_SPEC,
  SectorsStore,
  type SectorRow,
} from './sectors.store.js';
import { SECTORS_FLIGHT_CLIENT } from './sectors.token.js';

const DEFAULT_DATA_DIR = '../../data/sectors';
const DEFAULT_FLIGHT_TARGET = '127.0.0.1:8815';

@Module({
  imports: [StockMetaModule],
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
    {
      provide: SECTORS_FLIGHT_CLIENT,
      useFactory: (): FlightClient => {
        const target = process.env['QUANT_FLIGHT_TARGET'] ?? DEFAULT_FLIGHT_TARGET;
        return new FlightClient(target);
      },
    },
    SYSTEM_CLOCK_PROVIDER,
    SectorsStore,
    SectorsService,
    SectorInstructionHandler,
    SectorPublishInstructionHandler,
    SectorUnpublishInstructionHandler,
    SectorRefreshInstructionHandler,
    SectorShowInstructionHandler,
    SectorRmInstructionHandler,
  ],
  exports: [SectorsStore, SectorsService],
})
export class SectorsModule {}
