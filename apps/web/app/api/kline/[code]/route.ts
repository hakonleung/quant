import { KlineBarSchema, TRACE_HEADER } from '@quant/shared';
import { z } from 'zod';

import { bffErrorResponse, nestJson, readTrace } from '../../_lib/proxy.js';

const ListSchema = z.array(KlineBarSchema);
const RangeSchema = z.enum(['30D', '50D', '90D', '250D']);

interface Params {
  readonly params: Promise<{ readonly code: string }>;
}

export async function GET(request: Request, { params }: Params): Promise<Response> {
  const { code } = await params;
  const traceId = readTrace(request);
  const url = new URL(request.url);
  const parsedRange = RangeSchema.safeParse(url.searchParams.get('range') ?? '90D');
  const range = parsedRange.success ? parsedRange.data : '90D';
  try {
    const bars = await nestJson(
      request,
      `/api/kline/${encodeURIComponent(code)}?range=${range}`,
      (raw) => ListSchema.parse(raw),
    );
    return Response.json(bars, { headers: { [TRACE_HEADER]: traceId } });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}
