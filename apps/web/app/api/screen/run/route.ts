/**
 * BFF for the decoupled screen executor.
 *
 *   POST /api/screen/run  { screenPlan, universePlan?, rank? }
 *     →  ScreenRunResult
 *
 * Pair endpoint: see `../nl2dsl/route.ts`. The AST shape is the same
 * `kind`-tagged form that the python `screen_run` op deserialises.
 */

import {
  RankSpecSchema,
  ScreenPlanAstSchema,
  ScreenRunResultSchema,
  TRACE_HEADER,
  UniversePlanAstSchema,
} from '@quant/shared';
import { z } from 'zod';

import { bffErrorResponse, nestJson, readTrace } from '../../_lib/proxy.js';

const BodySchema = z
  .object({
    screenPlan: ScreenPlanAstSchema,
    universePlan: UniversePlanAstSchema.nullable().optional(),
    rank: RankSpecSchema.nullable().optional(),
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
      '/api/screen/run',
      (raw) => ScreenRunResultSchema.parse(raw),
      { method: 'POST', body },
    );
    return Response.json(result, { headers: { [TRACE_HEADER]: traceId } });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}
