/**
 * BFF for the decoupled NL → AST translator.
 *
 *   POST /api/screen/nl2dsl  { nl, asof? }  →  NlToDslResult
 *
 * Pair endpoint: see `../run/route.ts` for execution. Frontend hooks
 * (`use-nl-screen.ts`) chain the two for the legacy NL → matches flow.
 */

import { NlToDslResultSchema, TRACE_HEADER } from '@quant/shared';
import { z } from 'zod';

import { bffErrorResponse, nestJson, readTrace } from '../../_lib/proxy.js';

const BodySchema = z
  .object({
    nl: z.string().min(1).max(500),
    asof: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
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
      '/api/screen/nl2dsl',
      (raw) => NlToDslResultSchema.parse(raw),
      { method: 'POST', body },
    );
    return Response.json(result, { headers: { [TRACE_HEADER]: traceId } });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}
