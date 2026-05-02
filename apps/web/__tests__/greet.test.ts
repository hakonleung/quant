import { describe, expect, it } from 'vitest';
import { QuantError } from '@quant/shared';
import { greet } from '../lib/fp/greet.js';

describe('greet', () => {
  it('should return "Hello, <name>" for a typical name (golden)', () => {
    expect(greet('World')).toBe('Hello, World');
  });

  it.each([
    ['A', 'Hello, A'],
    ['Quant', 'Hello, Quant'],
    ['你好', 'Hello, 你好'],
  ])('should handle "%s" → "%s" (boundary: short / unicode)', (input, expected) => {
    expect(greet(input)).toBe(expected);
  });

  it('should throw QuantError with code INVALID_ARGUMENT when name is empty (raise path)', () => {
    expect(() => greet('')).toThrow(QuantError);
    try {
      greet('');
    } catch (err) {
      expect(err).toBeInstanceOf(QuantError);
      if (err instanceof QuantError) {
        expect(err.code).toBe('INVALID_ARGUMENT');
      }
    }
  });

  it('should be deterministic / pure (invariant: same input → same output)', () => {
    expect(greet('x')).toBe(greet('x'));
  });
});
