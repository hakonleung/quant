/**
 * BFF: GET / PUT `/api/sectors` → forward to NestJS `/api/sectors`.
 */

import { TRACE_HEADER, SectorSchema, SectorsReplaceBodySchema } from '@quant/shared';
import { z } from 'zod';

import { bffErrorResponse, nestJson, readTrace } from '../_lib/proxy.js';

const ListResponseSchema = z.object({ sectors: z.array(SectorSchema) });

export async function GET(request: Request): Promise<Response> {
  const traceId = readTrace(request);
  try {
    const body = await nestJson(request, '/api/sectors', (r) => ListResponseSchema.parse(r));
    return Response.json(body, { headers: { [TRACE_HEADER]: traceId } });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}

export async function PUT(request: Request): Promise<Response> {
  const traceId = readTrace(request);
  try {
    const raw: unknown = await request.json();
    const body = SectorsReplaceBodySchema.parse(raw);
    const out = await nestJson(request, '/api/sectors', (r) => ListResponseSchema.parse(r), {
      method: 'PUT',
      body,
    });
    return Response.json(out, { headers: { [TRACE_HEADER]: traceId } });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}
