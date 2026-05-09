/**
 * Global module exposing the NestJS LLM client + user ledger.
 *
 * Marked `@Global` because every feature module that calls an LLM
 * (`/screen` NL→DSL, `/analyze`, future `/agent`) needs the same
 * `LlmService` and `UserLlmLedgerStore` instance. Putting it in every
 * feature's `imports[]` would just be ceremony.
 */

import { Global, Module } from '@nestjs/common';

import { SYSTEM_CLOCK_PROVIDER } from '../../common/clock.js';
import { LlmLedgerRecorder } from './ledger/llm-ledger.recorder.js';
import { UserLlmLedgerStore } from './ledger/user-llm-ledger.store.js';
import { loadLlmConfig, LLM_CONFIG, type LlmConfig } from './llm.config.js';
import { LlmService } from './llm.service.js';
import { LLM_LEDGER_DATA_DIR } from './llm.tokens.js';

const DEFAULT_DATA_DIR = '../../data';

@Global()
@Module({
  providers: [
    SYSTEM_CLOCK_PROVIDER,
    {
      provide: LLM_CONFIG,
      useFactory: (): LlmConfig => loadLlmConfig(process.env),
    },
    {
      provide: LLM_LEDGER_DATA_DIR,
      useFactory: (): string => process.env['QUANT_LLM_LEDGER_DIR'] ?? DEFAULT_DATA_DIR,
    },
    UserLlmLedgerStore,
    LlmLedgerRecorder,
    LlmService,
  ],
  exports: [LlmService, UserLlmLedgerStore],
})
export class LlmModule {}
