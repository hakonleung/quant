import { StockMetaDtoSchema, TRACE_HEADER } from '@quant/shared';

import { bffErrorResponse, nestJson, readTrace } from '../../_lib/proxy.js';

interface Params {
  readonly params: Promise<{ readonly code: string }>;
}

export async function GET(request: Request, { params }: Params): Promise<Response> {
  const { code } = await params;
  const traceId = readTrace(request);
  try {
    const dto = await nestJson(
      request,
      `/api/stocks/${encodeURIComponent(code)}`,
      (raw) => StockMetaDtoSchema.parse(raw),
    );
    return Response.json(dto, { headers: { [TRACE_HEADER]: traceId } });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}
