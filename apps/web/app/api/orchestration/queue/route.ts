import { QueueSnapshotSchema, TRACE_HEADER } from '@quant/shared';

import { bffErrorResponse, nestJson, readTrace } from '../../_lib/proxy.js';

export async function GET(request: Request): Promise<Response> {
  const traceId = readTrace(request);
  try {
    const snap = await nestJson(request, '/api/orchestration/queue', (raw) =>
      QueueSnapshotSchema.parse(raw),
    );
    return Response.json(snap, { headers: { [TRACE_HEADER]: traceId } });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}
