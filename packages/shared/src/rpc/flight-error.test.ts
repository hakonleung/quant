import { describe, expect, it } from 'vitest';
import { parseFlightErrorPayload } from './flight-error.js';

function envelope(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    code: 'STOCK_NOT_FOUND',
    message: 'no such stock',
    trace_id: 'abc',
    details: { code: '999999.SH' },
    ...extra,
  });
}

describe('parseFlightErrorPayload', () => {
  it('round-trips a valid envelope', () => {
    const payload = parseFlightErrorPayload(envelope());
    expect(payload).not.toBeNull();
    expect(payload!.code).toBe('STOCK_NOT_FOUND');
    expect(payload!.traceId).toBe('abc');
    expect(payload!.details).toEqual({ code: '999999.SH' });
  });

  it('locates the envelope after a gRPC status prefix and "Detail:" suffix', () => {
    const wrapped = `Failed to call /arrow.flight.protocol.FlightService/DoGet: ${envelope()}. Detail: Failed`;
    const payload = parseFlightErrorPayload(wrapped);
    expect(payload?.code).toBe('STOCK_NOT_FOUND');
  });

  it('tolerates braces inside string values', () => {
    const msg = `prefix ${JSON.stringify({
      v: 1,
      code: 'INTERNAL',
      message: 'oh no { }',
      trace_id: 't',
      details: {},
    })} suffix`;
    expect(parseFlightErrorPayload(msg)?.code).toBe('INTERNAL');
  });

  it('returns null for messages with no JSON', () => {
    expect(parseFlightErrorPayload('plain text')).toBeNull();
  });

  it('returns null for malformed JSON', () => {
    expect(parseFlightErrorPayload('{ not json')).toBeNull();
  });

  it('returns null for an unrecognised code', () => {
    expect(parseFlightErrorPayload(envelope({ code: 'NOT_AN_ERROR_CODE' }))).toBeNull();
  });

  it('returns null for the wrong envelope version', () => {
    expect(parseFlightErrorPayload(envelope({ v: 99 }))).toBeNull();
  });

  it('returns null when a required field has the wrong type', () => {
    expect(parseFlightErrorPayload(envelope({ trace_id: 123 }))).toBeNull();
  });

  it('returns null for a top-level array', () => {
    expect(parseFlightErrorPayload('[1,2,3]')).toBeNull();
  });

  it('returns null when details is missing', () => {
    const broken = JSON.stringify({ v: 1, code: 'INTERNAL', message: 'm', trace_id: 't' });
    expect(parseFlightErrorPayload(broken)).toBeNull();
  });

  it('returns null when no balanced object is found', () => {
    expect(parseFlightErrorPayload('prefix { unbalanced')).toBeNull();
  });
});
