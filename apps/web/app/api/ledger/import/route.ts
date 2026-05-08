/**
 * BFF: POST /api/ledger/import → merge-import a JSON file payload.
 */

import { LedgerEntrySchema, LedgerSnapshotSchema, TRACE_HEADER } from '@quant/shared';
import { z } from 'zod';

import { bffErrorResponse, nestJson, readTrace } from '../../_lib/proxy.js';

const ImportSchema = z.object({ entries: z.array(LedgerEntrySchema) }).strict();

export async function POST(request: Request): Promise<Response> {
  const traceId = readTrace(request);
  try {
    const raw: unknown = await request.json();
    const body = ImportSchema.parse(raw);
    const updated = await nestJson(
      request,
      '/api/ledger/import',
      (r) => LedgerSnapshotSchema.parse(r),
      { method: 'POST', body },
    );
    return Response.json(updated, { headers: { [TRACE_HEADER]: traceId } });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}
