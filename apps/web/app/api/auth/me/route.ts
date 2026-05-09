/**
 * BFF: GET `/api/auth/me` → forward to NestJS.
 *
 * Returns the resolved `AuthenticatedUser` for the current session. The
 * terminal's `usr` command and the FE user-chip rely on this; without a
 * BFF passthrough it 404s on the client (Next routes don't auto-proxy).
 */

import { TRACE_HEADER } from '@quant/shared';
import { z } from 'zod';

import { bffErrorResponse, nestJson, readTrace } from '../../_lib/proxy.js';

const AuthMeSchema = z.object({
  id: z.string().min(1),
  displayName: z.string(),
  source: z.enum(['oauth', 'env', 'im']),
  imBootstrap: z.boolean(),
  originalUserId: z.string().optional(),
});

export async function GET(request: Request): Promise<Response> {
  const traceId = readTrace(request);
  try {
    const body = await nestJson(request, '/api/auth/me', (r) => AuthMeSchema.parse(r));
    return Response.json(body, { headers: { [TRACE_HEADER]: traceId } });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}
