/**
 * BFF: PATCH  /api/ledger/:date  → patch one entry
 *      DELETE /api/ledger/:date  → delete one entry
 */

import { LedgerEntrySchema, TRACE_HEADER } from '@quant/shared';
import { z } from 'zod';

import { bffErrorResponse, nestJson, nestProxy, readTrace } from '../../_lib/proxy.js';

interface RouteContext {
  readonly params: Promise<{ readonly date: string }>;
}

const PatchSchema = z
  .object({
    pnlAmount: z
      .string()
      .regex(/^-?\d+(\.\d+)?$/u)
      .optional(),
    closingPosition: z
      .string()
      .regex(/^-?\d+(\.\d+)?$/u)
      .nullable()
      .optional(),
  })
  .strict();

export async function PATCH(request: Request, ctx: RouteContext): Promise<Response> {
  const traceId = readTrace(request);
  try {
    const { date } = await ctx.params;
    const raw: unknown = await request.json();
    const body = PatchSchema.parse(raw);
    const updated = await nestJson(
      request,
      `/api/ledger/${encodeURIComponent(date)}`,
      (r) => LedgerEntrySchema.parse(r),
      { method: 'PATCH', body },
    );
    return Response.json(updated, { headers: { [TRACE_HEADER]: traceId } });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}

export async function DELETE(request: Request, ctx: RouteContext): Promise<Response> {
  const { date } = await ctx.params;
  return nestProxy(request, `/api/ledger/${encodeURIComponent(date)}`, { method: 'DELETE' });
}
