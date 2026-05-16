/**
 * Composition root for the screen feature
 * (modules/03-screening.md + modules/07-frontend.md §4.3.3).
 *
 * Screen execution is now fully in-process: the AST evaluator + the
 * universe filter run inside NestJS over the local kline / meta stores
 * (DuckDB). No Flight channel is required for `runDsl`. The NL→DSL
 * translation still calls the LLM (NestJS-side) but produces an AST
 * that the local executor consumes.
 */

import { Module } from '@nestjs/common';

import { SYSTEM_CLOCK_PROVIDER } from '../../common/clock.js';
import { KlineModule } from '../kline/kline.module.js';
import { StockListModule } from '../stock-list/stock-list.module.js';
import { StockMetaModule } from '../stock-meta/stock-meta.module.js';
import { NlToDslService } from './nl-to-dsl.service.js';
import { ScreenController } from './screen.controller.js';
import { ScreenExecService } from './screen-exec.service.js';
import { ScreenService } from './screen.service.js';
import { UniverseFilterService } from './universe-filter.service.js';

@Module({
  imports: [KlineModule, StockMetaModule, StockListModule],
  controllers: [ScreenController],
  providers: [
    SYSTEM_CLOCK_PROVIDER,
    NlToDslService,
    UniverseFilterService,
    ScreenExecService,
    ScreenService,
    // `screen` migrated to `BeInstructionCenter` (instruction-center/cells/screen.cell.ts).
  ],
  exports: [ScreenService, ScreenExecService],
})
export class ScreenModule {}
