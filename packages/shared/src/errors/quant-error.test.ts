import { describe, expect, it } from 'vitest';
import { QuantError } from './quant-error.js';

describe('QuantError', () => {
  it('should expose code, message, and frozen details (golden)', () => {
    const err = new QuantError('STOCK_NOT_FOUND', 'no such stock', { code: '600519.SH' });
    expect(err.code).toBe('STOCK_NOT_FOUND');
    expect(err.message).toBe('no such stock');
    expect(err.details).toEqual({ code: '600519.SH' });
    expect(Object.isFrozen(err.details)).toBe(true);
  });

  it('should default details to empty frozen object (boundary)', () => {
    const err = new QuantError('INTERNAL', 'oops');
    expect(err.details).toEqual({});
    expect(Object.isFrozen(err.details)).toBe(true);
  });

  it('should be an instance of Error (invariant: subclass contract)', () => {
    const err = new QuantError('INTERNAL', 'x');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('QuantError');
  });

  it('should not allow mutating details after construction (regression: shared mutability)', () => {
    const input = { a: 1 };
    const err = new QuantError('INTERNAL', 'x', input);
    input.a = 999;
    expect(err.details).toEqual({ a: 1 });
  });
});
