/**
 * Facade over the screening pipeline:
 *
 *   - `runNl(nl, ctx)` — full NL → DSL → execute. Calls `NlToDslService`
 *     (NestJS-side LLM) to translate, then evaluates the resulting AST
 *     via the in-process `ScreenExecService`.
 *   - `nlToDsl(nl, ctx)` — translation only, no execution. Used by the
 *     "AST editor" UI.
 *   - `runDsl(plan, universe, rank, traceId)` — execute an already-built
 *     AST. No LLM call; doesn't take a userId because no LLM ledger entry
 *     is produced.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  NlScreenResultSchema,
  ScreenRunResultSchema,
  type NlScreenResult,
  type NlToDslResult,
  type RankSpecView,
  type ScreenPlanAst,
  type ScreenRunResult,
  type UniversePlanAst,
} from '@quant/shared';

import { CLOCK, type Clock } from '../../common/clock.js';
import { NlToDslService } from './nl-to-dsl.service.js';
import { ScreenExecService } from './screen-exec.service.js';

export interface ScreenLlmContext {
  readonly userId: string;
  readonly traceId: string;
}

@Injectable()
export class ScreenService {
  private readonly logger = new Logger(ScreenService.name);

  constructor(
    @Inject(ScreenExecService) private readonly exec: ScreenExecService,
    @Inject(NlToDslService) private readonly nlToDslService: NlToDslService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Full NL → matches pipeline. Translates the natural-language query
   * (LLM call) then evaluates the resulting AST in-process via
   * `ScreenExecService`.
   */
  async runNl(
    nl: string,
    asof: string | undefined,
    ctx: ScreenLlmContext,
  ): Promise<NlScreenResult> {
    const resolvedAsof = asof ?? this.clock.now().toISOString().slice(0, 10);
    const translation = await this.nlToDslService.translate({
      nl,
      asof: resolvedAsof,
      userId: ctx.userId,
      traceId: ctx.traceId,
    });
    const run = await this.runDsl(
      translation.screenPlan,
      translation.universePlan,
      translation.rank,
      ctx.traceId,
    );
    if (translation.warnings.length > 0) {
      this.logger.log(
        `nl_to_dsl_warnings count=${String(translation.warnings.length)} trace_id=${ctx.traceId}`,
      );
    }
    const result: NlScreenResult = {
      nl,
      asof: resolvedAsof,
      screenPlan: translation.screenPlan,
      universePlan: translation.universePlan,
      rank: translation.rank,
      matches: run.matches,
      planSignature: run.planSignature,
    };
    // Validate end-to-end so any drift between translation + Python op
    // surfaces here, not deep inside the FE renderer.
    return NlScreenResultSchema.parse(result);
  }

  /**
   * Translate-only path. No Python op is invoked; useful when the FE
   * wants to render the parsed AST for user review before paying the
   * screen-execution cost.
   */
  async nlToDsl(
    nl: string,
    asof: string | undefined,
    ctx: ScreenLlmContext,
  ): Promise<NlToDslResult> {
    const resolvedAsof = asof ?? this.clock.now().toISOString().slice(0, 10);
    const translation = await this.nlToDslService.translate({
      nl,
      asof: resolvedAsof,
      userId: ctx.userId,
      traceId: ctx.traceId,
    });
    return {
      nl,
      asof: resolvedAsof,
      screenPlan: translation.screenPlan,
      universePlan: translation.universePlan,
      rank: translation.rank,
    };
  }

  async runDsl(
    screenPlan: ScreenPlanAst,
    universePlan: UniversePlanAst | null | undefined,
    rank: RankSpecView | null | undefined,
    traceId: string,
  ): Promise<ScreenRunResult> {
    this.logger.log(`screen_exec_start trace_id=${traceId}`);
    const result = await this.exec.execute(screenPlan, universePlan ?? null, rank ?? null);
    // Validate to lock the public contract — same parse the Flight path used.
    return ScreenRunResultSchema.parse(result);
  }
}
