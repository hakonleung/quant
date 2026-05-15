/**
 * BFF: POST /api/stock-list/rows → forward to NestJS
 * `/stock-list/rows`. Re-validates the upstream payload against the
 * shared zod contract so any drift surfaces here, not in the browser.
 */

import {
  StockListRowsResponseSchema,
  TRACE_HEADER,
  type StockListRowsResponse,
} from '@quant/shared';

import { bffErrorResponse, nestJson, readTrace } from '../../_lib/proxy.js';

export async function POST(request: Request): Promise<Response> {
  const traceId = readTrace(request);
  try {
    const body = (await request.json()) as unknown;
    const out: StockListRowsResponse = await nestJson(
      request,
      `/api/stock-list/rows`,
      (raw) => StockListRowsResponseSchema.parse(raw),
      { method: 'POST', body },
    );
    return Response.json(out, { headers: { [TRACE_HEADER]: traceId } });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}
