/**
 * BFF for sentiment analyze_many.
 *
 *   GET  ?codes=600519,000001[&windowDays=30]   →  cache-only aggregate read
 *   POST {codes:[...], windowDays?, bypassCache?} → fresh aggregate analysis
 *
 * The frontend uses a single react-query key per `codeHash` and calls
 * `invalidateQueries` after a successful POST, so the GET re-fetches
 * the now-warm cache.
 */

import { MarketSentimentSchema, TRACE_HEADER } from '@quant/shared';
import { z } from 'zod';

import { bffErrorResponse, nestJson, readTrace } from '../../_lib/proxy.js';

const codeRule = z.string().regex(/^\d{6}$/, 'expected 6-digit code');

const PostBodySchema = z
  .object({
    codes: z.array(codeRule).min(1).max(200),
    windowDays: z.number().int().positive().max(365).optional(),
    bypassCache: z.boolean().optional(),
  })
  .strict();

export async function GET(request: Request): Promise<Response> {
  const traceId = readTrace(request);
  const url = new URL(request.url);
  const codes = url.searchParams.get('codes') ?? '';
  if (codes.length === 0) {
    return Response.json(
      { code: 'INVALID_ARGUMENT', message: 'codes is required', trace_id: traceId, details: {} },
      { status: 400, headers: { [TRACE_HEADER]: traceId } },
    );
  }
  const params = new URLSearchParams({ codes });
  const window = url.searchParams.get('windowDays');
  if (window !== null) params.set('windowDays', window);
  try {
    const data = await nestJson(
      request,
      `/api/sentiment/analyze_many?${params.toString()}`,
      (raw) => MarketSentimentSchema.parse(raw),
    );
    return Response.json(data, { headers: { [TRACE_HEADER]: traceId } });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const traceId = readTrace(request);
  let body: z.infer<typeof PostBodySchema>;
  try {
    const raw: unknown = await request.json();
    body = PostBodySchema.parse(raw);
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
    const data = await nestJson(
      request,
      '/api/sentiment/analyze_many',
      (raw) => MarketSentimentSchema.parse(raw),
      { method: 'POST', body },
    );
    return Response.json(data, { headers: { [TRACE_HEADER]: traceId } });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}
