/**
 * BFF: GET /api/watch/lookup?market=&code= → NestJS `/api/watch/lookup`.
 *
 * Used by the Watch add-form to confirm a ticker exists before posting
 * a task. Re-validates the upstream payload against the shared
 * `StockBasicSchema` so contract drift fails on the BFF, not in the
 * browser.
 */

import { StockBasicSchema, TRACE_HEADER } from '@quant/shared';

import { bffErrorResponse, nestJson, readTrace } from '../../_lib/proxy.js';

export async function GET(request: Request): Promise<Response> {
  const traceId = readTrace(request);
  try {
    const url = new URL(request.url);
    const market = url.searchParams.get('market') ?? '';
    const code = url.searchParams.get('code') ?? '';
    const params = new URLSearchParams({ market, code }).toString();
    const dto = await nestJson(request, `/api/watch/lookup?${params}`, (raw) =>
      StockBasicSchema.parse(raw),
    );
    return Response.json(dto, { headers: { [TRACE_HEADER]: traceId } });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}
