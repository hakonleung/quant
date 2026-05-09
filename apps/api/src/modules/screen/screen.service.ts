/**
 * Facade over the screening pipeline:
 *
 *   - `runNl(nl, ctx)` — full NL → DSL → execute. Calls `NlToDslService`
 *     (NestJS-side LLM, replaces the deleted Python `nl_to_dsl_service`)
 *     to translate, then dispatches the resulting AST through the existing
 *     Python `screen_run` Flight op.
 *   - `nlToDsl(nl, ctx)` — translation only, no execution. Used by the
 *     "AST editor" UI.
 *   - `runDsl(plan, universe, rank, traceId)` — execute an already-built
 *     AST. No LLM call; doesn't take a userId because no LLM ledger entry
 *     is produced.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  NlScreenResultSchema,
  QuantError,
  ScreenRunResultSchema,
  type NlScreenResult,
  type NlToDslResult,
  type RankSpecView,
  type ScreenPlanAst,
  type ScreenRunResult,
  type UniversePlanAst,
} from '@quant/shared';
import type { Table } from 'apache-arrow';

import { CLOCK, type Clock } from '../../common/clock.js';
import { FlightClient } from '../../adapters/flight/flight-client.js';
import { NlToDslService } from './nl-to-dsl.service.js';
import { SCREEN_FLIGHT_CLIENT } from './screen.token.js';

export interface ScreenLlmContext {
  readonly userId: string;
  readonly traceId: string;
}

@Injectable()
export class ScreenService {
  private readonly logger = new Logger(ScreenService.name);

  constructor(
    @Inject(SCREEN_FLIGHT_CLIENT) private readonly flight: FlightClient,
    @Inject(NlToDslService) private readonly nlToDslService: NlToDslService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Full NL → matches pipeline. Translates the natural-language query in
   * NestJS (LLM call), then executes the resulting AST via the Python
   * `screen_run` Flight op.
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
    const args: Record<string, unknown> = {
      screen_plan: JSON.stringify(screenPlan),
    };
    if (universePlan !== undefined && universePlan !== null) {
      args['universe_plan'] = JSON.stringify(universePlan);
    }
    if (rank !== undefined && rank !== null) {
      args['rank'] = JSON.stringify(rank);
    }
    const payload = await this.callOp('screen_run', args, traceId);
    if (payload === null) {
      throw new QuantError('DSL_INVALID', 'screen_run returned no payload', {});
    }
    return ScreenRunResultSchema.parse(payload);
  }

  private async callOp(
    op: string,
    args: Record<string, unknown>,
    traceId: string,
  ): Promise<unknown> {
    const result = await this.flight.doGet(op, args, { traceId });
    return extractFirstPayload(result.value);
  }
}

function extractFirstPayload(table: Table): unknown {
  if (table.numRows === 0) return null;
  const proxy = table.get(0);
  if (proxy === null) return null;
  const row: Readonly<Record<string, unknown>> = proxy.toJSON();
  const json = row['payload_json'];
  if (typeof json !== 'string' || json.length === 0) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
