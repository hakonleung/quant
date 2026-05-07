/**
 * BFF: GET `/api/blacklist` → forward to NestJS.
 * Cron-managed A-share noise list (see docs/modules/12-blacklist.md).
 */

import { TRACE_HEADER, BlacklistSnapshotSchema } from '@quant/shared';

import { bffErrorResponse, nestJson, readTrace } from '../_lib/proxy.js';

export async function GET(request: Request): Promise<Response> {
  const traceId = readTrace(request);
  try {
    const body = await nestJson(request, '/api/blacklist', (r) => BlacklistSnapshotSchema.parse(r));
    return Response.json(body, { headers: { [TRACE_HEADER]: traceId } });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}
