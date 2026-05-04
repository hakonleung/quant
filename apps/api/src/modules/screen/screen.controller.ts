/**
 * HTTP routes for the NL → DSL → screen pipeline (modules/03-screening.md
 * + modules/07-frontend.md §4.3.3).
 *
 *   POST /api/screen/nl       { nl, asof? }     → NlScreenResult           (combined, kept for back-compat)
 *   POST /api/screen/nl2dsl   { nl, asof? }     → NlToDslResult            (translate only — no screen execution)
 *   POST /api/screen/run      { screenPlan,
 *                               universePlan?,
 *                               rank? }         → ScreenRunResult          (execute AST — no LLM call)
 *
 * Why three: `nl2dsl` and `run` are the truly decoupled APIs. The combined
 * `/nl` op is retained so existing callers that want a one-round-trip
 * `NL → matches` pipeline don't pay an extra hop. The Python Flight gateway
 * exposes matching ops `nl_screen` / `nl_to_dsl` / `screen_run`.
 *
 * Why POST: the underlying `nl2dsl` op invokes a paid LLM call; the
 * `run` op mutates a Polars compute pool. Both need POST per the
 * cache-mutating-must-be-POST rule.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Inject,
  Post,
  Req,
} from '@nestjs/common';
import {
  NlScreenResultSchema,
  NlToDslResultSchema,
  ScreenRunResultSchema,
  ScreenPlanAstSchema,
  UniversePlanAstSchema,
  RankSpecSchema,
  type NlScreenResult,
  type NlToDslResult,
  type ScreenRunResult,
} from '@quant/shared';
import type { Request } from 'express';
import type { Table } from 'apache-arrow';
import { z } from 'zod';

import { FlightClient } from '../../adapters/flight/flight-client.js';
import { ZodValidationPipe } from '../../common/zod-pipe.js';
import { SCREEN_FLIGHT_CLIENT } from './screen.token.js';

const NlBodySchema = z
  .object({
    nl: z.string().min(1).max(500),
    asof: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .strict();
type NlBody = z.infer<typeof NlBodySchema>;
const nlBodyPipe = new ZodValidationPipe(NlBodySchema);

const RunBodySchema = z
  .object({
    screenPlan: ScreenPlanAstSchema,
    universePlan: UniversePlanAstSchema.nullable().optional(),
    rank: RankSpecSchema.nullable().optional(),
  })
  .strict();
type RunBody = z.infer<typeof RunBodySchema>;
const runBodyPipe = new ZodValidationPipe(RunBodySchema);

@Controller('screen')
export class ScreenController {
  constructor(@Inject(SCREEN_FLIGHT_CLIENT) private readonly flight: FlightClient) {}

  @Post('nl')
  async run(
    @Req() req: Request,
    @Body(nlBodyPipe) body: NlBody,
  ): Promise<NlScreenResult> {
    const traceId = (req as Request & { traceId?: string }).traceId ?? '';
    const args: Record<string, unknown> = { nl: body.nl };
    if (body.asof !== undefined) args['asof'] = body.asof;
    const payload = await this.callOp('nl_screen', args, { traceId });
    if (payload === null) {
      throw new BadRequestException({
        code: 'NL_TRANSLATION_FAILED',
        message: 'nl_screen returned no payload',
        details: { nl: body.nl },
      });
    }
    return NlScreenResultSchema.parse(payload);
  }

  @Post('nl2dsl')
  async nl2dsl(
    @Req() req: Request,
    @Body(nlBodyPipe) body: NlBody,
  ): Promise<NlToDslResult> {
    const traceId = (req as Request & { traceId?: string }).traceId ?? '';
    const args: Record<string, unknown> = { nl: body.nl };
    if (body.asof !== undefined) args['asof'] = body.asof;
    const payload = await this.callOp('nl_to_dsl', args, { traceId });
    if (payload === null) {
      throw new BadRequestException({
        code: 'NL_TRANSLATION_FAILED',
        message: 'nl_to_dsl returned no payload',
        details: { nl: body.nl },
      });
    }
    return NlToDslResultSchema.parse(payload);
  }

  @Post('run')
  async runScreen(
    @Req() req: Request,
    @Body(runBodyPipe) body: RunBody,
  ): Promise<ScreenRunResult> {
    const traceId = (req as Request & { traceId?: string }).traceId ?? '';
    // Flight args are flat primitives — nested AST goes through as a
    // JSON string and the python op deserialises it back to a domain
    // object (see services/py/quant_rpc/ops/screen_ops.py).
    const args: Record<string, unknown> = {
      screen_plan: JSON.stringify(body.screenPlan),
    };
    if (body.universePlan !== undefined && body.universePlan !== null) {
      args['universe_plan'] = JSON.stringify(body.universePlan);
    }
    if (body.rank !== undefined && body.rank !== null) {
      args['rank'] = JSON.stringify(body.rank);
    }
    const payload = await this.callOp('screen_run', args, { traceId });
    if (payload === null) {
      throw new BadRequestException({
        code: 'DSL_INVALID',
        message: 'screen_run returned no payload',
        details: {},
      });
    }
    return ScreenRunResultSchema.parse(payload);
  }

  private async callOp(
    op: string,
    args: Record<string, unknown>,
    opts: { readonly traceId: string },
  ): Promise<unknown | null> {
    const result = await this.flight.doGet(op, args, opts);
    return extractFirstPayload(result.value);
  }
}

function extractFirstPayload(table: Table): unknown | null {
  if (table.numRows === 0) return null;
  const proxy = table.get(0);
  if (proxy === null) return null;
  const row = proxy.toJSON() as { payload_json?: unknown };
  const json = row.payload_json;
  if (typeof json !== 'string' || json.length === 0) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
