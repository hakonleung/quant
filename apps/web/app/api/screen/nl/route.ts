/**
 * BFF for the NL → DSL → screen pipeline.
 *
 *   POST /api/screen/nl  { nl, asof? }  →  NlScreenResult
 *
 * Frontend uses this as a mutation; there's no GET twin because the
 * AST + matches always change with the input string.
 */

import { NlScreenResultSchema, TRACE_HEADER } from '@quant/shared';
import { z } from 'zod';

import { bffErrorResponse, nestJson, readTrace } from '../../_lib/proxy.js';

const BodySchema = z
  .object({
    nl: z.string().min(1).max(500),
    asof: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .strict();

export async function POST(request: Request): Promise<Response> {
  const traceId = readTrace(request);
  let body: z.infer<typeof BodySchema>;
  try {
    const raw: unknown = await request.json();
    body = BodySchema.parse(raw);
  } catch (err) {
    return Response.json(
      {
        code: 'INVALID_ARGUMENT',
        message: err instanceof Error ? err.message : String(err),
        trace_id: traceId,
        details: {},
      },
      { status: 400, headers: { [TRACE_HEADER]: traceId } },
    );
  }
  try {
    const result = await nestJson(
      request,
      '/api/screen/nl',
      (raw) => NlScreenResultSchema.parse(raw),
      { method: 'POST', body },
    );
    return Response.json(result, { headers: { [TRACE_HEADER]: traceId } });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}
