import { ScanKindSchema, ScanResultSchema, TRACE_HEADER } from '@quant/shared';

import { bffErrorResponse, nestJson, readTrace } from '../../_lib/proxy.js';

export async function POST(request: Request): Promise<Response> {
  const traceId = readTrace(request);
  try {
    const url = new URL(request.url);
    const kind = ScanKindSchema.default('all').parse(url.searchParams.get('kind') ?? 'all');
    const result = await nestJson(
      request,
      `/api/orchestration/scan?kind=${kind}`,
      (raw) => ScanResultSchema.parse(raw),
      { method: 'POST', body: {} },
    );
    return Response.json(result, { headers: { [TRACE_HEADER]: traceId } });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}
