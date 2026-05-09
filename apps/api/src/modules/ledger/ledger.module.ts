import { Module } from '@nestjs/common';

import { FlightClient } from '../../adapters/flight/flight-client.js';
import { SYSTEM_CLOCK_PROVIDER } from '../../common/clock.js';
import { AnalyzeInstructionHandler } from './instructions/analyze.handler.js';
import { LedgerInstructionHandler } from './instructions/ledger.handler.js';
import { LedgerCacheStore } from './ledger-cache.store.js';
import { LedgerController } from './ledger.controller.js';
import { LedgerService } from './ledger.service.js';
import { LedgerStore } from './ledger.store.js';
import { LEDGER_FLIGHT_CLIENT } from './ledger.token.js';

const DEFAULT_FLIGHT_TARGET = '127.0.0.1:8815';

@Module({
  controllers: [LedgerController],
  providers: [
    {
      provide: LEDGER_FLIGHT_CLIENT,
      useFactory: (): FlightClient => {
        const target = process.env['QUANT_FLIGHT_TARGET'] ?? DEFAULT_FLIGHT_TARGET;
        return new FlightClient(target);
      },
    },
    SYSTEM_CLOCK_PROVIDER,
    LedgerStore,
    LedgerCacheStore,
    LedgerService,
    LedgerInstructionHandler,
    AnalyzeInstructionHandler,
  ],
  exports: [LedgerStore, LedgerService],
})
export class LedgerModule {}
