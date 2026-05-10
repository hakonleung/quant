/**
 * HTTP routes for technical analysis (beta).
 *
 *   GET  /api/ta/analyze_one?code=xxx   → cached read; 404 on miss
 *   POST /api/ta/analyze_one {code,...} → fresh analysis (LLM, paid)
 *   POST /api/ta/analyze_many {codes,...} → sector fan-out + LLM summary
 *
 * The full pipeline runs in NestJS (kline read via Flight, meta via the
 * stock-meta service, prompt + LLM via LlmService, cache via the
 * file-per-code TaCacheStore). The Python `analyze_ta_one` /
 * `get_cached_ta_one` Flight ops were retired with the TA migration —
 * see `apps/api/src/modules/ta/ta.service.ts` for the orchestration.
 *
 * Sector fan-out concurrency is bounded by the body schema's `codes`
 * array cap (50). Each member call hits TaCacheStore first; the LLM
 * sector summary is one extra `LlmService.completeJson` call.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { type TaAnalysis, type TaSectorAnalysis } from '@quant/shared';
import { z } from 'zod';
import type { Request } from 'express';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/request-with-user.js';
import { ZodValidationPipe } from '../../common/zod-pipe.js';
import {
  AnalyzeTaOneBodySchema,
  AnalyzeTaOneQuerySchema,
  type AnalyzeTaOneBody,
  type AnalyzeTaOneQuery,
} from './dto/ta.dto.js';
import { TaService } from './ta.service.js';

const queryPipe = new ZodValidationPipe(AnalyzeTaOneQuerySchema);
const bodyPipe = new ZodValidationPipe(AnalyzeTaOneBodySchema);

const codeRule = z.string().regex(/^\d{6}$/u, 'expected 6-digit code');
const AnalyzeTaManyBodySchema = z
  .object({
    codes: z.array(codeRule).min(1).max(50),
    label: z.string().min(1).optional(),
    bypassCache: z.boolean().optional(),
  })
  .strict();
type AnalyzeTaManyBody = z.infer<typeof AnalyzeTaManyBodySchema>;
const manyBodyPipe = new ZodValidationPipe(AnalyzeTaManyBodySchema);

@Controller('ta')
export class TaController {
  constructor(@Inject(TaService) private readonly ta: TaService) {}

  @Get('analyze_one')
  async getOneCached(
    @Req() req: Request,
    @Query(queryPipe) query: AnalyzeTaOneQuery,
  ): Promise<TaAnalysis> {
    const traceId = traceOf(req);
    const cached = await this.ta.getCached(query.code, traceId);
    if (cached === null) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: `no cached ta for ${query.code}`,
        details: { code: query.code },
      });
    }
    return cached;
  }

  @Post('analyze_one')
  async analyzeOne(
    @Req() req: Request,
    @CurrentUser() user: AuthenticatedUser,
    @Body(bodyPipe) body: AnalyzeTaOneBody,
  ): Promise<TaAnalysis> {
    const traceId = traceOf(req);
    return this.ta.analyzeOne(body.code, body.bypassCache === true, {
      userId: user.id,
      traceId,
    });
  }

  @Post('analyze_many')
  async analyzeMany(
    @Req() req: Request,
    @CurrentUser() user: AuthenticatedUser,
    @Body(manyBodyPipe) body: AnalyzeTaManyBody,
  ): Promise<TaSectorAnalysis> {
    const traceId = traceOf(req);
    try {
      return await this.ta.analyzeSector({
        codes: body.codes,
        label: body.label ?? `${String(body.codes.length)} codes`,
        ...(body.bypassCache === true ? { bypassCache: true } : {}),
        ctx: { userId: user.id, traceId },
      });
    } catch (err) {
      if (err instanceof Error && err.message === 'no member TA could be produced') {
        throw new BadRequestException({
          code: 'EVALUATION_FAILED',
          message: err.message,
          details: { codes: [...body.codes] },
        });
      }
      throw err;
    }
  }
}

function traceOf(req: Request): string {
  const r = req as Request & { traceId?: string };
  return r.traceId ?? '';
}
