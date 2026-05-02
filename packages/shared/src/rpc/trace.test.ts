import { describe, expect, it } from 'vitest';
import { TRACE_HEADER, newTraceId } from './trace.js';

describe('TRACE_HEADER', () => {
  it('matches the lowercase form gRPC normalises to', () => {
    expect(TRACE_HEADER).toBe('x-trace-id');
  });
});

describe('newTraceId', () => {
  it('returns 32 lowercase hex chars (UUIDv4 minus dashes)', () => {
    const id = newTraceId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is unique across many invocations', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) ids.add(newTraceId());
    expect(ids.size).toBe(100);
  });
});
