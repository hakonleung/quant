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

import { BadRequestException, Body, Controller, Inject, Post, Req } from '@nestjs/common';
import {
  QuantError,
  ScreenPlanAstSchema,
  UniversePlanAstSchema,
  RankSpecSchema,
  type NlScreenResult,
  type NlToDslResult,
  type ScreenRunResult,
} from '@quant/shared';
import type { Request } from 'express';
import { z } from 'zod';

import { ZodValidationPipe } from '../../common/zod-pipe.js';
import { ScreenService } from './screen.service.js';

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
  constructor(@Inject(ScreenService) private readonly screen: ScreenService) {}

  @Post('nl')
  async run(@Req() req: Request, @Body(nlBodyPipe) body: NlBody): Promise<NlScreenResult> {
    const traceId = (req as Request & { traceId?: string }).traceId ?? '';
    try {
      return await this.screen.runNl(body.nl, body.asof, traceId);
    } catch (err) {
      throw mapToHttp(err, body.nl);
    }
  }

  @Post('nl2dsl')
  async nl2dsl(@Req() req: Request, @Body(nlBodyPipe) body: NlBody): Promise<NlToDslResult> {
    const traceId = (req as Request & { traceId?: string }).traceId ?? '';
    try {
      return await this.screen.nlToDsl(body.nl, body.asof, traceId);
    } catch (err) {
      throw mapToHttp(err, body.nl);
    }
  }

  @Post('run')
  async runScreen(@Req() req: Request, @Body(runBodyPipe) body: RunBody): Promise<ScreenRunResult> {
    const traceId = (req as Request & { traceId?: string }).traceId ?? '';
    try {
      return await this.screen.runDsl(
        body.screenPlan,
        body.universePlan ?? null,
        body.rank ?? null,
        traceId,
      );
    } catch (err) {
      throw mapToHttp(err, body.screenPlan);
    }
  }
}

function mapToHttp(err: unknown, contextValue: unknown): unknown {
  if (err instanceof QuantError) {
    return new BadRequestException({
      code: err.code,
      message: err.message,
      details: err.code === 'NL_TRANSLATION_FAILED' ? { nl: contextValue } : {},
    });
  }
  return err;
}
