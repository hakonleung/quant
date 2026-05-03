/**
 * BFF: GET /api/stocks → forward to NestJS `/api/stocks`.
 * Re-validates the upstream payload through the shared schema so a
 * gateway/Python contract drift fails here, on the BFF, rather than
 * silently in the browser.
 */

import { StockMetaDtoSchema, TRACE_HEADER, type StockMetaDto } from '@quant/shared';
import { z } from 'zod';

import { bffErrorResponse, nestJson, readTrace } from '../_lib/proxy.js';

const ListSchema = z.array(StockMetaDtoSchema);

export async function GET(request: Request): Promise<Response> {
  const traceId = readTrace(request);
  try {
    const rows: readonly StockMetaDto[] = await nestJson(
      request,
      '/api/stocks',
      (raw) => ListSchema.parse(raw),
    );
    return Response.json(rows, { headers: { [TRACE_HEADER]: traceId } });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}
