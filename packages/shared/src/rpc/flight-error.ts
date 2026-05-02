/**
 * Mirrors {@link services/py/quant_rpc/errors.py} on the TS side. The
 * Python Flight server tunnels structured error info through a JSON
 * blob inside `FlightServerError.message` because Flight does not have
 * a structured error code field. Both sides agree on the envelope:
 *
 * ```json
 * { "v": 1, "code": "...", "message": "...", "trace_id": "...", "details": {} }
 * ```
 *
 * gRPC may prefix the wire message (e.g. "Failed to call .../DoGet:")
 * and suffix it (`. Detail: Failed`), so the parser locates the JSON by
 * scanning for the first `{` and decoding via `JSON.parse` after
 * isolating the balanced object.
 */

import type { ErrorCode } from '../contracts/errors.js';
import { isErrorCode } from '../contracts/errors.js';

const ENVELOPE_VERSION = 1;

export interface FlightErrorPayload {
  readonly v: number;
  readonly code: ErrorCode;
  readonly message: string;
  readonly traceId: string;
  readonly details: Readonly<Record<string, unknown>>;
}

/**
 * Try to extract a Quant Flight error envelope from a server-error message
 * string. Returns `null` if the string is not a Quant envelope.
 */
export function parseFlightErrorPayload(message: string): FlightErrorPayload | null {
  const candidate = locateBalancedJson(message);
  if (candidate === null) return null;
  const doc = parseJsonObject(candidate);
  if (doc === null) return null;
  return validateEnvelope(doc);
}

function locateBalancedJson(s: string): string | null {
  const start = s.indexOf('{');
  if (start === -1) return null;
  return extractBalancedJson(s, start);
}

function parseJsonObject(s: string): Readonly<Record<string, unknown>> | null {
  let doc: unknown;
  try {
    doc = JSON.parse(s);
  } catch {
    return null;
  }
  return isObjectRecord(doc) ? doc : null;
}

function isObjectRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateEnvelope(obj: Readonly<Record<string, unknown>>): FlightErrorPayload | null {
  if (obj['v'] !== ENVELOPE_VERSION) return null;

  const code = obj['code'];
  const msg = obj['message'];
  const traceId = obj['trace_id'];
  const details = obj['details'];

  if (typeof code !== 'string' || !isErrorCode(code)) return null;
  if (typeof msg !== 'string') return null;
  if (typeof traceId !== 'string') return null;
  if (!isObjectRecord(details)) return null;

  return {
    v: ENVELOPE_VERSION,
    code,
    message: msg,
    traceId,
    details: Object.freeze({ ...details }),
  };
}

/**
 * Walk the string from `start` (which must be `{`) and return the substring
 * spanning the balanced JSON object. Returns null if the braces never balance.
 * Tracks string literals so braces inside strings don't confuse the scan.
 */
function extractBalancedJson(s: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return s.slice(start, i + 1);
      }
    }
  }
  return null;
}
