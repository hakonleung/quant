import { Logger, Module } from '@nestjs/common';

import { SYSTEM_CLOCK_PROVIDER } from '../../common/clock.js';
import type { UserScopedRecordStore } from '../../common/storage/ports/user-scoped-record-store.port.js';
import { AUTH_CONFIG, type AuthConfigShape } from '../auth/config/auth.config.js';
import { LedgerAnalyzeInstructionHandler } from './instructions/ledger-analyze.handler.js';
import { LedgerInstructionHandler } from './instructions/ledger.handler.js';
import { LedgerCacheStore } from './ledger-cache.store.js';
import { LedgerController } from './ledger.controller.js';
import { LedgerService } from './ledger.service.js';
import {
  buildLedgerUserScopedStore,
  LedgerStore,
  type LedgerRow,
} from './ledger.store.js';
import { LEDGER_USER_RECORD_STORE } from './ledger.tokens.js';

@Module({
  controllers: [LedgerController],
  providers: [
    SYSTEM_CLOCK_PROVIDER,
    {
      provide: LEDGER_USER_RECORD_STORE,
      inject: [AUTH_CONFIG],
      useFactory: (cfg: AuthConfigShape): UserScopedRecordStore<LedgerRow> =>
        buildLedgerUserScopedStore(cfg, new Logger(LedgerStore.name)),
    },
    LedgerStore,
    LedgerCacheStore,
    LedgerService,
    LedgerInstructionHandler,
    LedgerAnalyzeInstructionHandler,
  ],
  exports: [LedgerStore, LedgerService],
})
export class LedgerModule {}
