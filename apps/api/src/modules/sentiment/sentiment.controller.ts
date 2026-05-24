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
 * Full pipeline runs in NestJS (`NewsSentimentService`); the Python
 * sentiment ops + cache are gone with the migration.
 */

import { Body, Controller, Get, Inject, NotFoundException, Post, Query, Req } from '@nestjs/common';
import {
  isValidWatchCode,
  WatchMarketSchema,
  type MarketSentiment,
  type Sentiment,
  type WatchMarket,
} from '@quant/shared';
import type { Request } from 'express';
import { z } from 'zod';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/request-with-user.js';
import { ZodValidationPipe } from '../../common/zod-pipe.js';
import { NewsSentimentService } from './news-sentiment.service.js';

const DEFAULT_WINDOW_DAYS = 30;
const codeRule = z.string().min(1);
const codeMismatchMsg =
  'code does not match market (a=6 digits, hk=4-5 digits, us=letters)';

const AnalyzeOneQuerySchema = z
  .object({
    market: WatchMarketSchema.default('a'),
    code: codeRule,
    windowDays: z.coerce.number().int().positive().max(365).optional(),
  })
  .strict()
  .refine((v) => isValidWatchCode(v.market, v.code), {
    message: codeMismatchMsg,
    path: ['code'],
  });
const AnalyzeOneBodySchema = z
  .object({
    market: WatchMarketSchema.default('a'),
    code: codeRule,
    windowDays: z.number().int().positive().max(365).optional(),
    bypassCache: z.boolean().optional(),
  })
  .strict()
  .refine((v) => isValidWatchCode(v.market, v.code), {
    message: codeMismatchMsg,
    path: ['code'],
  });
type AnalyzeOneBody = z.infer<typeof AnalyzeOneBodySchema>;
type AnalyzeOneQuery = z.infer<typeof AnalyzeOneQuerySchema>;

const AnalyzeManyQuerySchema = z
  .object({
    market: WatchMarketSchema.default('a'),
    codes: z.string().min(1, 'codes is required'),
    windowDays: z.coerce.number().int().positive().max(365).optional(),
  })
  .strict();
const AnalyzeManyBodySchema = z
  .object({
    market: WatchMarketSchema.default('a'),
    codes: z.array(codeRule).min(1).max(200),
    windowDays: z.number().int().positive().max(365).optional(),
    bypassCache: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.codes.every((c) => isValidWatchCode(v.market, c)), {
    message: 'every code must match market',
    path: ['codes'],
  });
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
    const cached = await this.service.getCachedStock(query.market, query.code, windowDays);
    if (cached === null) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: `no cached sentiment for ${query.market}:${query.code}`,
        details: { market: query.market, code: query.code },
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
        market: body.market,
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
    const codes = parseCodesQuery(query.codes, query.market);
    const windowDays = query.windowDays ?? DEFAULT_WINDOW_DAYS;
    const cached = await this.service.getCachedMarket(query.market, codes, windowDays);
    if (cached === null) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'no cached market sentiment for codes',
        details: { market: query.market, codes },
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
        market: body.market,
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

function parseCodesQuery(raw: string, market: WatchMarket): readonly string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && isValidWatchCode(market, s));
}
