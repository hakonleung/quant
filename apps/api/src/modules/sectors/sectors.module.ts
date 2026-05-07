import { Module } from '@nestjs/common';

import { FlightClient } from '../../adapters/flight/flight-client.js';
import { SYSTEM_CLOCK_PROVIDER } from '../../common/clock.js';
import { SectorsController } from './sectors.controller.js';
import { SECTORS_DATA_DIR, SectorsStore } from './sectors.store.js';
import { SECTORS_FLIGHT_CLIENT } from './sectors.token.js';

const DEFAULT_DATA_DIR = '../../data/sectors';
const DEFAULT_FLIGHT_TARGET = '127.0.0.1:8815';

@Module({
  controllers: [SectorsController],
  providers: [
    {
      provide: SECTORS_DATA_DIR,
      useFactory: (): string => process.env['QUANT_SECTORS_DIR'] ?? DEFAULT_DATA_DIR,
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
  ],
  exports: [SectorsStore],
})
export class SectorsModule {}
