import { Module } from '@nestjs/common';

import { SYSTEM_CLOCK_PROVIDER } from '../../common/clock.js';
import { LedgerAnalyzeInstructionHandler } from './instructions/ledger-analyze.handler.js';
import { LedgerInstructionHandler } from './instructions/ledger.handler.js';
import { LedgerCacheStore } from './ledger-cache.store.js';
import { LedgerController } from './ledger.controller.js';
import { LedgerService } from './ledger.service.js';
import { LedgerStore } from './ledger.store.js';

@Module({
  controllers: [LedgerController],
  providers: [
    SYSTEM_CLOCK_PROVIDER,
    LedgerStore,
    LedgerCacheStore,
    LedgerService,
    LedgerInstructionHandler,
    LedgerAnalyzeInstructionHandler,
  ],
  exports: [LedgerStore, LedgerService],
})
export class LedgerModule {}
