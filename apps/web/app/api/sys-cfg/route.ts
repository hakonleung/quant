/**
 * BFF: GET / PUT `/api/sys-cfg` → forward to NestJS `/api/sys-cfg`.
 */

import { SysCfgSchema, TRACE_HEADER } from '@quant/shared';

import { bffErrorResponse, nestJson, readTrace } from '../_lib/proxy.js';

export async function GET(request: Request): Promise<Response> {
  const traceId = readTrace(request);
  try {
    const body = await nestJson(request, '/api/sys-cfg', (r) => SysCfgSchema.parse(r));
    return Response.json(body, { headers: { [TRACE_HEADER]: traceId } });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}

export async function PUT(request: Request): Promise<Response> {
  const traceId = readTrace(request);
  try {
    const raw: unknown = await request.json();
    const body = SysCfgSchema.parse(raw);
    const out = await nestJson(request, '/api/sys-cfg', (r) => SysCfgSchema.parse(r), {
      method: 'PUT',
      body,
    });
    return Response.json(out, { headers: { [TRACE_HEADER]: traceId } });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}
