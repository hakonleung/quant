/**
 * BFF: POST `/api/sectors/:id/publish` → forward to NestJS.
 * Toggles a sector's `published` flag and returns the updated record.
 */

import { TRACE_HEADER, SectorPublishBodySchema, SectorSchema } from '@quant/shared';
import { z } from 'zod';

import { bffErrorResponse, nestJson, readTrace } from '../../../_lib/proxy.js';

const PublishResponseSchema = z.object({ sector: SectorSchema });

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
    const raw: unknown = await request.json();
    const body = SectorPublishBodySchema.parse(raw);
    const out = await nestJson(
      request,
      `/api/sectors/${encodeURIComponent(id)}/publish`,
      (r) => PublishResponseSchema.parse(r),
      { method: 'POST', body },
    );
    return Response.json(out, { headers: { [TRACE_HEADER]: traceId } });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}
