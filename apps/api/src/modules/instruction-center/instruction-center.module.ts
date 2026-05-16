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
import { LedgerModule } from '../ledger/ledger.module.js';
import { ScreenModule } from '../screen/screen.module.js';
import { SectorsModule } from '../sectors/sectors.module.js';
import { SentimentModule } from '../sentiment/sentiment.module.js';
import { StockListModule } from '../stock-list/stock-list.module.js';
import { StockMetaModule } from '../stock-meta/stock-meta.module.js';
import { TaModule } from '../ta/ta.module.js';
import { WatchModule } from '../watch/watch.module.js';

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
    forwardRef((): typeof WatchModule => WatchModule),
    forwardRef((): typeof StockListModule => StockListModule),
    forwardRef((): typeof SentimentModule => SentimentModule),
    forwardRef((): typeof TaModule => TaModule),
    forwardRef((): typeof ScreenModule => ScreenModule),
  ],
  providers: [SYSTEM_CLOCK_PROVIDER, BeInstructionCenter],
  exports: [BeInstructionCenter],
})
export class InstructionCenterModule {}
