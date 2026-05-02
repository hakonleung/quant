/**
 * Generates / propagates the per-request `x-trace-id` so every log line
 * downstream and every Flight call can be correlated end-to-end. Header
 * name and id format are shared with the Python side via `@quant/shared`
 * so the two ends agree by construction (ipc-py-ts.md §5).
 *
 * The id is also written into the response so curl/dev-tools can read it.
 * `req.traceId` carries the value into controllers via the
 * `TraceContext` request-scoped provider (defined separately to keep
 * Express coupling out of the Nest providers graph).
 */

import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { TRACE_HEADER, newTraceId } from '@quant/shared';

/** Request shape after `TraceMiddleware` has run. */
export interface RequestWithTraceId extends Request {
  traceId: string;
}

function asTraceableRequest(req: Request): RequestWithTraceId {
  // Express's Request is open-ended at runtime; we attach `traceId` here
  // and read it back in downstream handlers via this same interface.
  return req as RequestWithTraceId;
}

@Injectable()
export class TraceMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const inbound = req.header(TRACE_HEADER);
    const traceId = inbound !== undefined && inbound.length > 0 ? inbound : newTraceId();
    asTraceableRequest(req).traceId = traceId;
    res.setHeader(TRACE_HEADER, traceId);
    next();
  }
}
