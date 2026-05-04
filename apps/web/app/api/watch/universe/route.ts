/**
 * BFF: GET /api/watch/universe?market=hk|us → NestJS `/api/watch/universe`.
 *
 * Returns the cached HK/US universe (StockBasic[]). The frontend
 * combines this with the A-stock universe served by `/api/stocks` to
 * power the cross-market stock-search dropdown (M-0 / W-0).
 */

import { StockBasicSchema, TRACE_HEADER } from '@quant/shared';
import { z } from 'zod';

import { bffErrorResponse, nestJson, readTrace } from '../../_lib/proxy.js';

const ListSchema = z.array(StockBasicSchema);

export async function GET(request: Request): Promise<Response> {
  const traceId = readTrace(request);
  try {
    const url = new URL(request.url);
    const market = url.searchParams.get('market') ?? '';
    const params = new URLSearchParams({ market }).toString();
    const list = await nestJson(request, `/api/watch/universe?${params}`, (raw) =>
      ListSchema.parse(raw),
    );
    return Response.json(list, { headers: { [TRACE_HEADER]: traceId } });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}
