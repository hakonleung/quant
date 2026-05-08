/**
 * BFF: GET  /api/ledger/analyze → cached analysis (404 on miss)
 *      POST /api/ledger/analyze → fresh analysis (paid LLM)
 */

import { LedgerAnalysisSchema, TRACE_HEADER } from '@quant/shared';
import { z } from 'zod';

import { bffErrorResponse, nestJson, nestProxy, readTrace } from '../../_lib/proxy.js';

const PostSchema = z.object({ bypassCache: z.boolean().optional() }).strict();

export async function GET(request: Request): Promise<Response> {
  // Use nestProxy so the 404-on-miss flows through verbatim — the
  // frontend's `safeOne` helper turns that into a `null`.
  return nestProxy(request, '/api/ledger/analyze');
}

export async function POST(request: Request): Promise<Response> {
  const traceId = readTrace(request);
  try {
    const raw: unknown = await request.json().catch(() => ({}));
    const body = PostSchema.parse(raw);
    const result = await nestJson(
      request,
      '/api/ledger/analyze',
      (r) => LedgerAnalysisSchema.parse(r),
      { method: 'POST', body },
    );
    return Response.json(result, { headers: { [TRACE_HEADER]: traceId } });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}
