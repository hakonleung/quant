import { describe, expect, it } from 'vitest';
import { ERROR_CODES, ERROR_HTTP_STATUS, ERROR_NUMBERS, isErrorCode } from './errors.js';

// Cross-language drift between this module and the Python equivalent is
// prevented by `pnpm gen:proto:check` (CI gate); these tests focus on
// internal invariants the generator must maintain.
describe('contract: error codes (TS side)', () => {
  it('every code has a number and http entry (golden)', () => {
    for (const code of ERROR_CODES) {
      expect(typeof ERROR_NUMBERS[code]).toBe('number');
      expect(typeof ERROR_HTTP_STATUS[code]).toBe('number');
    }
  });

  it('numbers are unique (invariant: stable enum)', () => {
    const numbers = ERROR_CODES.map((c) => ERROR_NUMBERS[c]);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('http status falls in 100..599 (boundary)', () => {
    for (const code of ERROR_CODES) {
      const status = ERROR_HTTP_STATUS[code];
      expect(status).toBeGreaterThanOrEqual(100);
      expect(status).toBeLessThanOrEqual(599);
    }
  });

  it('OK and INTERNAL sentinels are present', () => {
    expect(ERROR_CODES).toContain('OK');
    expect(ERROR_CODES).toContain('INTERNAL');
  });

  it('isErrorCode accepts every generated code', () => {
    for (const code of ERROR_CODES) {
      expect(isErrorCode(code)).toBe(true);
    }
  });

  it('isErrorCode rejects unknown strings and non-strings (raise path)', () => {
    expect(isErrorCode('NOT_A_REAL_CODE')).toBe(false);
    expect(isErrorCode('')).toBe(false);
    expect(isErrorCode(42)).toBe(false);
    expect(isErrorCode(undefined)).toBe(false);
    expect(isErrorCode(null)).toBe(false);
    expect(isErrorCode({})).toBe(false);
  });
});
