/**
 * HTTP routes for sentiment (modules/05-sentiment.md).
 *
 *   GET  /api/sentiment/analyze_one?code=xxx          → cached read; 404 on miss
 *   POST /api/sentiment/analyze_one  {code,...}        → fresh analysis (LLM)
 *   GET  /api/sentiment/analyze_many?codes=a,b[&...]   → cached aggregate read
 *   POST /api/sentiment/analyze_many {codes,...}       → fresh aggregate analysis
 *
 * Both verbs share a path so the BFF + react-query keep one key per
 * resource and revalidate the GET query after a POST mutation.
 *
 * `market` is **not** part of the wire format. The boundary takes
 * `code` (single) or `codes` (aggregate) and downstream layers
 * (`NewsSentimentService`, `SentimentCacheStore`) infer market once
 * via `inferMarketFromCode`. This keeps three layers from juggling
 * the same param. Validation rejects codes that match no market.
 */

import { Body, Controller, Get, Inject, NotFoundException, Post, Query, Req } from '@nestjs/common';
import {
  inferMarketFromCode,
  type MarketSentiment,
  type Sentiment,
} from '@quant/shared';
import type { Request } from 'express';
import { z } from 'zod';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/request-with-user.js';
import { ZodValidationPipe } from '../../common/zod-pipe.js';
import { NewsSentimentService } from './news-sentiment.service.js';

const DEFAULT_WINDOW_DAYS = 30;
const codeRule = z
  .string()
  .min(1)
  .refine((c) => inferMarketFromCode(c) !== null, {
    message: 'code matches no known market (a=6 digits, hk=4-5 digits, us=letters)',
  });

const AnalyzeOneQuerySchema = z
  .object({
    code: codeRule,
    windowDays: z.coerce.number().int().positive().max(365).optional(),
  })
  .strict();
const AnalyzeOneBodySchema = z
  .object({
    code: codeRule,
    windowDays: z.number().int().positive().max(365).optional(),
    bypassCache: z.boolean().optional(),
  })
  .strict();
type AnalyzeOneBody = z.infer<typeof AnalyzeOneBodySchema>;
type AnalyzeOneQuery = z.infer<typeof AnalyzeOneQuerySchema>;

const AnalyzeManyQuerySchema = z
  .object({
    codes: z.string().min(1, 'codes is required'),
    windowDays: z.coerce.number().int().positive().max(365).optional(),
  })
  .strict();
const AnalyzeManyBodySchema = z
  .object({
    codes: z.array(codeRule).min(1).max(200),
    windowDays: z.number().int().positive().max(365).optional(),
    bypassCache: z.boolean().optional(),
  })
  .strict()
  .refine(
    (v) => {
      const first = inferMarketFromCode(v.codes[0] ?? '');
      return v.codes.every((c) => inferMarketFromCode(c) === first);
    },
    {
      message: 'codes span multiple markets — aggregate analysis requires a single market',
      path: ['codes'],
    },
  );
type AnalyzeManyQuery = z.infer<typeof AnalyzeManyQuerySchema>;
type AnalyzeManyBody = z.infer<typeof AnalyzeManyBodySchema>;

const oneQueryPipe = new ZodValidationPipe(AnalyzeOneQuerySchema);
const oneBodyPipe = new ZodValidationPipe(AnalyzeOneBodySchema);
const manyQueryPipe = new ZodValidationPipe(AnalyzeManyQuerySchema);
const manyBodyPipe = new ZodValidationPipe(AnalyzeManyBodySchema);

@Controller('sentiment')
export class SentimentController {
  constructor(@Inject(NewsSentimentService) private readonly service: NewsSentimentService) {}

  @Get('analyze_one')
  async getOneCached(
    @Req() _req: Request,
    @Query(oneQueryPipe) query: AnalyzeOneQuery,
  ): Promise<Sentiment> {
    const windowDays = query.windowDays ?? DEFAULT_WINDOW_DAYS;
    const cached = await this.service.getCachedStock(query.code, windowDays);
    if (cached === null) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: `no cached sentiment for ${query.code}`,
        details: { code: query.code },
      });
    }
    return cached;
  }

  @Post('analyze_one')
  async analyzeOne(
    @Req() req: Request,
    @CurrentUser() user: AuthenticatedUser,
    @Body(oneBodyPipe) body: AnalyzeOneBody,
  ): Promise<Sentiment> {
    return this.service.analyzeOne(
      {
        code: body.code,
        ...(body.windowDays !== undefined ? { windowDays: body.windowDays } : {}),
        ...(body.bypassCache !== undefined ? { bypassCache: body.bypassCache } : {}),
      },
      { userId: user.id, traceId: traceOf(req) },
    );
  }

  @Get('analyze_many')
  async getManyCached(
    @Req() _req: Request,
    @Query(manyQueryPipe) query: AnalyzeManyQuery,
  ): Promise<MarketSentiment> {
    const codes = parseCodesQuery(query.codes);
    const windowDays = query.windowDays ?? DEFAULT_WINDOW_DAYS;
    const cached = await this.service.getCachedMarket(codes, windowDays);
    if (cached === null) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'no cached market sentiment for codes',
        details: { codes },
      });
    }
    return cached;
  }

  @Post('analyze_many')
  async analyzeMany(
    @Req() req: Request,
    @CurrentUser() user: AuthenticatedUser,
    @Body(manyBodyPipe) body: AnalyzeManyBody,
  ): Promise<MarketSentiment> {
    return this.service.analyzeMany(
      {
        codes: [...body.codes],
        ...(body.windowDays !== undefined ? { windowDays: body.windowDays } : {}),
        ...(body.bypassCache !== undefined ? { bypassCache: body.bypassCache } : {}),
      },
      { userId: user.id, traceId: traceOf(req) },
    );
  }
}

function traceOf(req: Request): string {
  const r = req as Request & { traceId?: string };
  return r.traceId ?? '';
}

/**
 * GET query parser — only keeps codes that map to a known market. The
 * `AnalyzeManyBodySchema` does the same plus the single-market refine;
 * the GET path is cache-only so we just silently drop unknown codes.
 */
function parseCodesQuery(raw: string): readonly string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && inferMarketFromCode(s) !== null);
}
