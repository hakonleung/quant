/**
 * BFF: GET /api/ledger        → list raw entries
 *      POST /api/ledger       → create one entry
 */

import { LedgerEntrySchema, TRACE_HEADER, type LedgerEntry } from '@quant/shared';
import { z } from 'zod';

import { bffErrorResponse, nestJson, readTrace } from '../_lib/proxy.js';

const ListSchema = z.array(LedgerEntrySchema);

export async function GET(request: Request): Promise<Response> {
  const traceId = readTrace(request);
  try {
    const entries: readonly LedgerEntry[] = await nestJson(request, '/api/ledger', (r) =>
      ListSchema.parse(r),
    );
    return Response.json(entries, { headers: { [TRACE_HEADER]: traceId } });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const traceId = readTrace(request);
  try {
    const raw: unknown = await request.json();
    const body = LedgerEntrySchema.parse(raw);
    const created = await nestJson(request, '/api/ledger', (r) => LedgerEntrySchema.parse(r), {
      method: 'POST',
      body,
    });
    return Response.json(created, {
      status: 201,
      headers: { [TRACE_HEADER]: traceId },
    });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}
