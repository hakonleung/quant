/**
 * BFF: POST `/api/sectors/:id/refresh` → forward to NestJS.
 * Re-runs the sector's saved DSL via Python `screen_run` and returns
 * the refreshed sector (with new codes / evidence / lastScreenedAt).
 */

import { TRACE_HEADER, SectorSchema } from '@quant/shared';
import { z } from 'zod';

import { bffErrorResponse, nestJson, readTrace } from '../../../_lib/proxy.js';

const RefreshResponseSchema = z.object({ sector: SectorSchema });

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const traceId = readTrace(request);
  try {
    const { id } = await ctx.params;
    if (id.length === 0) {
      return Response.json(
        { code: 'INVALID_ARGUMENT', message: 'sector id required', trace_id: traceId, details: {} },
        { status: 400, headers: { [TRACE_HEADER]: traceId } },
      );
    }
    const out = await nestJson(
      request,
      `/api/sectors/${encodeURIComponent(id)}/refresh`,
      (r) => RefreshResponseSchema.parse(r),
      { method: 'POST', body: {} },
    );
    return Response.json(out, { headers: { [TRACE_HEADER]: traceId } });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}
