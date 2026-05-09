/**
 * BFF: GET /api/stocks/snapshots?codes=… → forward to NestJS
 * `/api/stocks/snapshots`. Re-validates the upstream payload against the
 * shared schema so a gateway/Python drift fails here, not in the browser.
 */

import { StockSnapshotDtoSchema, TRACE_HEADER, type StockSnapshotDto } from '@quant/shared';
import { z } from 'zod';

import { bffErrorResponse, nestJson, readTrace } from '../../_lib/proxy.js';

const ListSchema = z.array(StockSnapshotDtoSchema);

export async function GET(request: Request): Promise<Response> {
  const traceId = readTrace(request);
  try {
    // Mirrors `kline/bulk` semantics: an empty `codes=` value tells the
    // Python Flight server to expand to the full universe. The previous
    // short-circuit here returned `[]` and silently stranded every
    // snapshot-derived column on the EQ.LIST `All` sector view.
    const url = new URL(request.url);
    const codes = url.searchParams.get('codes') ?? '';
    const rows: readonly StockSnapshotDto[] = await nestJson(
      request,
      `/api/stocks/snapshots?codes=${encodeURIComponent(codes)}`,
      (raw) => ListSchema.parse(raw),
    );
    return Response.json(rows, { headers: { [TRACE_HEADER]: traceId } });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}
