/**
 * NestJS module exposing the `BeInstructionCenter` singleton.
 *
 * Imported by `InstructionModule` so the legacy `InstructionExecutor`
 * can intercept migrated ids. Globally exported so other modules
 * (agent bridge, IM listener, future webhooks) can also call the
 * center directly without going through the executor.
 */

import { Global, Module, forwardRef } from '@nestjs/common';

import { SYSTEM_CLOCK_PROVIDER } from '../../common/clock.js';
import { AgentModule } from '../agent/agent.module.js';
import { KlineModule } from '../kline/kline.module.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { OrchestrationModule } from '../orchestration/orchestration.module.js';
import { ScreenModule } from '../screen/screen.module.js';
import { SectorsModule } from '../sectors/sectors.module.js';
import { SentimentModule } from '../sentiment/sentiment.module.js';
import { StockListModule } from '../stock-list/stock-list.module.js';
import { StockMetaModule } from '../stock-meta/stock-meta.module.js';
import { TaModule } from '../ta/ta.module.js';
import { WatchModule } from '../watch/watch.module.js';

import { BE_INSTRUCTION_CENTER_PORT } from '../instruction/ports/be-instruction-center.port.js';
import { BeInstructionCenter } from './be-instruction-center.service.js';

/**
 * `AuthModule` and `LlmModule` are both `@Global()`, so AuthConfig +
 * UserLlmLedgerStore are visible without explicit imports here.
 * Module-scoped imports (`SectorsModule`, `LedgerModule`, …) come in
 * via `forwardRef` so feature-module ↔ center wiring tolerates the
 * historic circular hop where instruction handlers used to live in
 * the feature module itself.
 */
@Global()
@Module({
  imports: [
    forwardRef((): typeof SectorsModule => SectorsModule),
    forwardRef((): typeof LedgerModule => LedgerModule),
    forwardRef((): typeof StockMetaModule => StockMetaModule),
    forwardRef((): typeof KlineModule => KlineModule),
    forwardRef((): typeof WatchModule => WatchModule),
    forwardRef((): typeof StockListModule => StockListModule),
    forwardRef((): typeof SentimentModule => SentimentModule),
    forwardRef((): typeof TaModule => TaModule),
    forwardRef((): typeof ScreenModule => ScreenModule),
    forwardRef((): typeof OrchestrationModule => OrchestrationModule),
    forwardRef((): typeof AgentModule => AgentModule),
  ],
  providers: [
    SYSTEM_CLOCK_PROVIDER,
    BeInstructionCenter,
    // Bind the port token to the concrete singleton so registry +
    // executor can inject by interface without importing the class —
    // breaks the import cycle once agent cells move into the center.
    { provide: BE_INSTRUCTION_CENTER_PORT, useExisting: BeInstructionCenter },
  ],
  exports: [BeInstructionCenter, BE_INSTRUCTION_CENTER_PORT],
})
export class InstructionCenterModule {}
