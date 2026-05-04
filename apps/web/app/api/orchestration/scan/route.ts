import { ScanResultSchema, TRACE_HEADER } from '@quant/shared';

import { bffErrorResponse, nestJson, readTrace } from '../../_lib/proxy.js';

export async function POST(request: Request): Promise<Response> {
  const traceId = readTrace(request);
  try {
    const result = await nestJson(
      request,
      '/api/orchestration/scan',
      (raw) => ScanResultSchema.parse(raw),
      { method: 'POST', body: {} },
    );
    return Response.json(result, { headers: { [TRACE_HEADER]: traceId } });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}
