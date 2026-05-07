/**
 * BFF: GET /api/watch  → list tasks (one-shot)
 *      POST /api/watch → create task
 *
 * Live updates moved off SSE onto Socket.IO (`watch.snapshot` topic);
 * the GET handler returns a single snapshot for terminal `watch list`
 * commands and degraded clients without a socket connection.
 */

import { TRACE_HEADER, WatchTaskCreateSchema, WatchTaskSchema } from '@quant/shared';
import { z } from 'zod';

import { bffErrorResponse, nestJson, readTrace } from '../_lib/proxy.js';

const TaskListSchema = z.array(WatchTaskSchema);

export async function GET(request: Request): Promise<Response> {
  const traceId = readTrace(request);
  try {
    const tasks = await nestJson(request, '/api/watch', (r) => TaskListSchema.parse(r));
    return Response.json(tasks, { headers: { [TRACE_HEADER]: traceId } });
  } catch (err) {
    return bffErrorResponse(err, traceId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const traceId = readTrace(request);
  try {
    const raw: unknown = await request.json();
    const body = WatchTaskCreateSchema.parse(raw);
    const created = await nestJson(request, '/api/watch', (r) => WatchTaskSchema.parse(r), {
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
