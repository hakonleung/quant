import { BlotterRowSchema, TRACE_HEADER } from '@quant/shared';
import { z } from 'zod';

import { bffErrorResponse, nestJson, readTrace } from '../../_lib/proxy.js';

const ListSchema = z.array(BlotterRowSchema);

export async function GET(request: Request): Promise<Response> {
  const traceId = readTrace(request);
  const url = new URL(request.url);
  const ids = url.searchParams.get('ids') ?? '';
  try {
    const rows = await nestJson(
      request,
      `/api/sectors/hits?ids=${encodeURIComponent(ids)}`,
      (raw) => ListSchema.parse(raw),
    );
    return Response.json(rows, { headers: { [TRACE_HEADER]: traceId } });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}
