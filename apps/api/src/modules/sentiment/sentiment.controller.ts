/**
 * HTTP routes for sentiment (modules/06-sentiment-analysis.md +
 * modules/07-frontend.md §4.2).
 *
 *   GET  /api/sentiment/analyze_one?code=xxx           → cached read; 404 on miss
 *   POST /api/sentiment/analyze_one  {code,...}         → fresh analysis (LLM)
 *   GET  /api/sentiment/analyze_many?codes=a,b[&...]    → cached aggregate read
 *   POST /api/sentiment/analyze_many {codes,...}        → fresh aggregate analysis
 *
 * Both verbs share a path so the BFF + react-query can keep a single
 * key per resource and revalidate the GET query after a POST mutation.
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
import type { MarketSentiment, Sentiment } from '@quant/shared';
import type { Request } from 'express';
import { Table } from 'apache-arrow';
import { z } from 'zod';

import { FlightClient } from '../../adapters/flight/flight-client.js';
import { ZodValidationPipe } from '../../common/zod-pipe.js';
import { mapMarketSentimentToView, mapStockSentimentToView } from './domain/payload-mapper.js';
import { SENTIMENT_FLIGHT_CLIENT } from './sentiment.token.js';

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

const codeRule = z.string().regex(/^\d{6}$/, 'expected 6-digit code');

const AnalyzeOneQuerySchema = z.object({ code: codeRule }).strict();
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
  .strict();
type AnalyzeManyQuery = z.infer<typeof AnalyzeManyQuerySchema>;
type AnalyzeManyBody = z.infer<typeof AnalyzeManyBodySchema>;

const oneQueryPipe = new ZodValidationPipe(AnalyzeOneQuerySchema);
const oneBodyPipe = new ZodValidationPipe(AnalyzeOneBodySchema);
const manyQueryPipe = new ZodValidationPipe(AnalyzeManyQuerySchema);
const manyBodyPipe = new ZodValidationPipe(AnalyzeManyBodySchema);

// ---------------------------------------------------------------------------
// controller
// ---------------------------------------------------------------------------

@Controller('sentiment')
export class SentimentController {
  constructor(@Inject(SENTIMENT_FLIGHT_CLIENT) private readonly flight: FlightClient) {}

  @Get('analyze_one')
  async getOneCached(
    @Req() req: Request,
    @Query(oneQueryPipe) query: AnalyzeOneQuery,
  ): Promise<Sentiment> {
    const traceId = traceOf(req);
    const result = await this.flight.doGet(
      'get_cached_stock_sentiment',
      { code: query.code },
      { traceId },
    );
    const payload = extractFirstPayload(result.value);
    if (payload === null) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: `no cached sentiment for ${query.code}`,
        details: { code: query.code },
      });
    }
    return mapStockSentimentToView(payload);
  }

  @Post('analyze_one')
  async analyzeOne(
    @Req() req: Request,
    @Body(oneBodyPipe) body: AnalyzeOneBody,
  ): Promise<Sentiment> {
    const traceId = traceOf(req);
    const args: Record<string, unknown> = { code: body.code };
    if (body.windowDays !== undefined) args['window_days'] = body.windowDays;
    if (body.bypassCache !== undefined) args['bypass_cache'] = body.bypassCache;
    const result = await this.flight.doGet('analyze_one_stock_sentiment', args, { traceId });
    const payload = extractFirstPayload(result.value);
    if (payload === null) {
      throw new BadRequestException({
        code: 'LLM_FAILED',
        message: 'analyze_one returned no payload',
        details: { code: body.code },
      });
    }
    return mapStockSentimentToView(payload);
  }

  @Get('analyze_many')
  async getManyCached(
    @Req() req: Request,
    @Query(manyQueryPipe) query: AnalyzeManyQuery,
  ): Promise<MarketSentiment> {
    const traceId = traceOf(req);
    const codes = parseCodesQuery(query.codes);
    const args: Record<string, unknown> = { codes };
    if (query.windowDays !== undefined) args['window_days'] = query.windowDays;
    const result = await this.flight.doGet('get_cached_market_sentiment', args, { traceId });
    const payload = extractFirstPayload(result.value);
    if (payload === null) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'no cached market sentiment for codes',
        details: { codes },
      });
    }
    return mapMarketSentimentToView(payload, codes);
  }

  @Post('analyze_many')
  async analyzeMany(
    @Req() req: Request,
    @Body(manyBodyPipe) body: AnalyzeManyBody,
  ): Promise<MarketSentiment> {
    const traceId = traceOf(req);
    const args: Record<string, unknown> = { codes: [...body.codes] };
    if (body.windowDays !== undefined) args['window_days'] = body.windowDays;
    if (body.bypassCache !== undefined) args['bypass_cache'] = body.bypassCache;
    const result = await this.flight.doGet('analyze_many_stock_sentiment', args, { traceId });
    const payload = extractFirstPayload(result.value);
    if (payload === null) {
      throw new BadRequestException({
        code: 'LLM_FAILED',
        message: 'analyze_many returned no payload',
        details: { codes: body.codes },
      });
    }
    return mapMarketSentimentToView(payload, body.codes);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function traceOf(req: Request): string {
  const r = req as Request & { traceId?: string };
  return r.traceId ?? '';
}

function parseCodesQuery(raw: string): readonly string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d{6}$/.test(s));
}

/**
 * The Python sentiment ops emit a 1-row Arrow table whose only column
 * is `payload_json` (a JSON-encoded `StockSentiment` / `MarketSentiment`).
 * An empty table = cache miss. Anything malformed surfaces as `null`
 * and is handled by the controller as a 404 / bad-request.
 */
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
