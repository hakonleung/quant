import { describe, expect, it } from 'vitest';

import { parseInstructionLine } from './parser.js';
import { errResult, formatResult, okResult } from './result.js';

const KNOWN = new Set(['focus', 'watch', 'channel.echo', 'screen']);

describe('parseInstructionLine', () => {
  it('parses bare line with rest', () => {
    const r = parseInstructionLine('focus 600519', KNOWN);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.id).toBe('focus');
      expect(r.rest).toBe('600519');
    }
  });

  it('returns no-prefix when requirePrefix and no slash', () => {
    const r = parseInstructionLine('hello world', KNOWN, { requirePrefix: true });
    expect(r).toEqual({ ok: false, reason: 'no-prefix' });
  });

  it('strips slash when requirePrefix', () => {
    const r = parseInstructionLine('/focus 600519', KNOWN, { requirePrefix: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.id).toBe('focus');
  });

  it('returns not-found for unknown id', () => {
    expect(parseInstructionLine('unknown', KNOWN)).toEqual({ ok: false, reason: 'not-found' });
  });

  it('returns empty for blank input', () => {
    expect(parseInstructionLine('   ', KNOWN)).toEqual({ ok: false, reason: 'empty' });
    expect(parseInstructionLine('/', KNOWN, { requirePrefix: true })).toEqual({
      ok: false,
      reason: 'empty',
    });
  });

  it('accepts dotted id', () => {
    const r = parseInstructionLine('channel.echo a=1', KNOWN);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.id).toBe('channel.echo');
      expect(r.rest).toBe('a=1');
    }
  });

  it('rejects malformed id (uppercase)', () => {
    expect(parseInstructionLine('FOCUS', KNOWN)).toEqual({ ok: false, reason: 'not-found' });
  });

  it('preserves multi-token rest verbatim', () => {
    const r = parseInstructionLine('screen   limit=20  preset=ma', KNOWN);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rest).toBe('limit=20  preset=ma');
  });
});

describe('formatResult', () => {
  it('renders ok', () => {
    expect(formatResult(okResult('hello'))).toBe('hello');
  });
  it('renders err with code prefix', () => {
    expect(formatResult(errResult('validation', 'bad code'))).toBe('[validation] bad code');
  });
});
