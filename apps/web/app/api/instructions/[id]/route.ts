/**
 * BFF: POST `/api/instructions/:id` → forward to NestJS
 * `/api/instructions/:id`. The endpoint is the canonical FE→BE typed
 * dispatch surface — per-feature legacy endpoints retire as cells
 * migrate.
 *
 * Status codes pass through 1:1 so the FE client can map them to an
 * `InstructionEnvelope` (2xx → `ok: true, data`; 4xx/5xx → `ok: false,
 * error: { code, message }`).
 */

import { nestProxy } from '../../_lib/proxy.js';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, ctx: RouteContext): Promise<Response> {
  const { id } = await ctx.params;
  const init: { method: 'POST'; body?: unknown } = { method: 'POST' };
  try {
    const text = await request.text();
    init.body = text.length > 0 ? (JSON.parse(text) as unknown) : {};
  } catch {
    init.body = {};
  }
  return nestProxy(request, `/api/instructions/${encodeURIComponent(id)}`, init);
}
