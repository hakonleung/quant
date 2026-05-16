import { Logger, Module } from '@nestjs/common';

import { SYSTEM_CLOCK_PROVIDER } from '../../common/clock.js';
import type { UserScopedRecordStore } from '../../common/storage/ports/user-scoped-record-store.port.js';
import { AUTH_CONFIG, type AuthConfigShape } from '../auth/config/auth.config.js';
import {
  buildLedgerCacheUserScopedStore,
  LedgerCacheStore,
  type LedgerCacheRow,
} from './ledger-cache.store.js';
import { LEDGER_CACHE_USER_RECORD_STORE } from './ledger-cache.tokens.js';
import { LedgerController } from './ledger.controller.js';
import { LedgerService } from './ledger.service.js';
import { LedgerStore } from './ledger.store.js';

@Module({
  controllers: [LedgerController],
  providers: [
    SYSTEM_CLOCK_PROVIDER,
    {
      provide: LEDGER_CACHE_USER_RECORD_STORE,
      inject: [AUTH_CONFIG],
      useFactory: (cfg: AuthConfigShape): UserScopedRecordStore<LedgerCacheRow> =>
        buildLedgerCacheUserScopedStore(cfg, new Logger(LedgerCacheStore.name)),
    },
    LedgerStore,
    LedgerCacheStore,
    LedgerService,
    // `ledger` (list) / `ledger.analyze` migrated to `BeInstructionCenter`
    // (instruction-center/cells/ledger*.cell.ts).
  ],
  exports: [LedgerStore, LedgerService],
})
export class LedgerModule {}
