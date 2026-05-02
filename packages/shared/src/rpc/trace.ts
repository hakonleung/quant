/**
 * Shared trace-id constants. Header name matches the Python side
 * (`quant_rpc.trace.TRACE_HEADER`); both gateway and Flight server agree
 * on the lowercase form because gRPC normalises metadata keys to
 * lowercase.
 *
 * `newTraceId` returns a 32-char lowercase hex string (UUIDv4 without
 * dashes), matching Python's `quant_rpc.trace.new_trace_id`.
 */

import { randomUUID } from 'node:crypto';

export const TRACE_HEADER = 'x-trace-id' as const;

export function newTraceId(): string {
  return randomUUID().replace(/-/g, '');
}
