/**
 * BFF for sentiment analyze_one. Two verbs share the path so the
 * frontend can keep a single react-query key:
 *
 *   GET  ?code=600519  →  cached read; never invokes the LLM.
 *   POST {code}        →  trigger fresh analysis; on success the
 *                          frontend invalidates the GET query so the
 *                          UI re-fetches the now-warm cache.
 */

import {
  isValidWatchCode,
  SentimentSchema,
  TRACE_HEADER,
  WatchMarketSchema,
} from '@quant/shared';
import { z } from 'zod';

import { bffErrorResponse, nestJson, readTrace } from '../../_lib/proxy.js';

const codeMismatchMsg = 'code does not match market (a=6 digits, hk=4-5 digits, us=letters)';

const BodySchema = z
  .object({
    market: WatchMarketSchema.default('a'),
    code: z.string().min(1),
    windowDays: z.number().int().positive().max(365).optional(),
    bypassCache: z.boolean().optional(),
  })
  .strict()
  .refine((v) => isValidWatchCode(v.market, v.code), { message: codeMismatchMsg, path: ['code'] });

const QuerySchema = z
  .object({
    market: WatchMarketSchema.default('a'),
    code: z.string().min(1),
  })
  .strict()
  .refine((v) => isValidWatchCode(v.market, v.code), { message: codeMismatchMsg, path: ['code'] });

export async function GET(request: Request): Promise<Response> {
  const traceId = readTrace(request);
  const url = new URL(request.url);
  const parsed = QuerySchema.safeParse({
    market: url.searchParams.get('market') ?? 'a',
    code: url.searchParams.get('code') ?? '',
  });
  if (!parsed.success) {
    return Response.json(
      {
        code: 'INVALID_ARGUMENT',
        message: parsed.error.message,
        trace_id: traceId,
        details: {},
      },
      { status: 400, headers: { [TRACE_HEADER]: traceId } },
    );
  }
  const params = new URLSearchParams({ market: parsed.data.market, code: parsed.data.code });
  try {
    const cached = await nestJson(
      request,
      `/api/sentiment/analyze_one?${params.toString()}`,
      (raw) => SentimentSchema.parse(raw),
    );
    return Response.json(cached, { headers: { [TRACE_HEADER]: traceId } });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const traceId = readTrace(request);
  let body: z.infer<typeof BodySchema>;
  try {
    const raw: unknown = await request.json();
    body = BodySchema.parse(raw);
  } catch (err) {
    return Response.json(
      {
        code: 'INVALID_ARGUMENT',
        message: err instanceof Error ? err.message : String(err),
        trace_id: traceId,
        details: {},
      },
      { status: 400, headers: { [TRACE_HEADER]: traceId } },
    );
  }

  try {
    const result = await nestJson(
      request,
      '/api/sentiment/analyze_one',
      (raw) => SentimentSchema.parse(raw),
      { method: 'POST', body },
    );
    return Response.json(result, { headers: { [TRACE_HEADER]: traceId } });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}
