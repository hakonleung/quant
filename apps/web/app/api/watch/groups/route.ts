/**
 * BFF: GET /api/watch/groups → list groups
 *      POST /api/watch/groups → create group
 */

import { TRACE_HEADER, WatchGroupCreateSchema, WatchGroupSchema } from '@quant/shared';
import { z } from 'zod';

import { bffErrorResponse, nestJson, readTrace } from '../../_lib/proxy.js';

const GroupListSchema = z.array(WatchGroupSchema);

export async function GET(request: Request): Promise<Response> {
  const traceId = readTrace(request);
  try {
    const groups = await nestJson(request, '/api/watch/groups', (r) => GroupListSchema.parse(r));
    return Response.json(groups, { headers: { [TRACE_HEADER]: traceId } });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const traceId = readTrace(request);
  try {
    const raw: unknown = await request.json();
    const body = WatchGroupCreateSchema.parse(raw);
    const created = await nestJson(
      request,
      '/api/watch/groups',
      (r) => WatchGroupSchema.parse(r),
      {
        method: 'POST',
        body,
      },
    );
    return Response.json(created, {
      status: 201,
      headers: { [TRACE_HEADER]: traceId },
    });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}
