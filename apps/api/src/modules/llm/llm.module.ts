/**
 * Global module exposing the NestJS LLM client + user ledger.
 *
 * Marked `@Global` because every feature module that calls an LLM
 * (`/screen` NL→DSL, `/analyze`, future `/agent`) needs the same
 * `LlmService` and `UserLlmLedgerStore` instance. Putting it in every
 * feature's `imports[]` would just be ceremony.
 */

import { Global, Logger, Module } from '@nestjs/common';
import { ServerConfigCenter } from '@quant/config/server';

import { SYSTEM_CLOCK_PROVIDER } from '../../common/clock.js';
import type { UserScopedRecordStore } from '../../common/storage/ports/user-scoped-record-store.port.js';
import { LlmLedgerRecorder } from './ledger/llm-ledger.recorder.js';
import {
  buildUserLlmLedgerUserScopedStore,
  UserLlmLedgerStore,
  type UserLlmLedgerRow,
} from './ledger/user-llm-ledger.store.js';
import { LlmService } from './llm.service.js';
import {
  LLM_CONFIG,
  LLM_LEDGER_DATA_DIR,
  USER_LLM_LEDGER_USER_RECORD_STORE,
} from './llm.tokens.js';
import type { LlmConfig } from '@quant/config';

@Global()
@Module({
  providers: [
    SYSTEM_CLOCK_PROVIDER,
    {
      provide: LLM_CONFIG,
      useFactory: (): LlmConfig => ServerConfigCenter.get().llm,
    },
    {
      // Reuse the global dataRoot so the LLM ledger lands under the
      // same per-user tree (data/users/{userId}/...) every other
      // user-scoped store uses. Sourced from ServerConfigCenter.auth.
      provide: LLM_LEDGER_DATA_DIR,
      useFactory: (): string => ServerConfigCenter.get().auth.dataRoot,
    },
    {
      provide: USER_LLM_LEDGER_USER_RECORD_STORE,
      inject: [LLM_LEDGER_DATA_DIR],
      useFactory: (dataRoot: string): UserScopedRecordStore<UserLlmLedgerRow> =>
        buildUserLlmLedgerUserScopedStore(dataRoot, new Logger(UserLlmLedgerStore.name)),
    },
    UserLlmLedgerStore,
    LlmLedgerRecorder,
    LlmService,
  ],
  exports: [LlmService, UserLlmLedgerStore],
})
export class LlmModule {}
