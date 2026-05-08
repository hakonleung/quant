import { describe, expect, it } from 'vitest';

import { structuralEqual } from './structural-equal.js';

describe('structuralEqual primitives', () => {
  it('reference / value equality', () => {
    expect(structuralEqual(1, 1)).toBe(true);
    expect(structuralEqual('x', 'x')).toBe(true);
    expect(structuralEqual(true, true)).toBe(true);
    expect(structuralEqual(null, null)).toBe(true);
    expect(structuralEqual(undefined, undefined)).toBe(true);
  });

  it('mismatched primitives', () => {
    expect(structuralEqual(1, 2)).toBe(false);
    expect(structuralEqual('a', 'b')).toBe(false);
    expect(structuralEqual(true, false)).toBe(false);
  });

  it('null vs object is not equal', () => {
    expect(structuralEqual(null, {})).toBe(false);
    expect(structuralEqual({}, null)).toBe(false);
  });

  it('undefined vs null is not equal', () => {
    expect(structuralEqual<null | undefined>(undefined, null)).toBe(false);
  });

  it('number vs string with same toString are not equal', () => {
    expect(structuralEqual<unknown>(1, '1')).toBe(false);
  });
});

describe('structuralEqual arrays', () => {
  it('reference shortcut', () => {
    const a = [1, 2, 3];
    expect(structuralEqual(a, a)).toBe(true);
  });

  it('same content, different references', () => {
    expect(structuralEqual([1, 2, 3], [1, 2, 3])).toBe(true);
  });

  it('length mismatch exits early', () => {
    expect(structuralEqual([1, 2], [1, 2, 3])).toBe(false);
  });

  it('order matters', () => {
    expect(structuralEqual([1, 2, 3], [3, 2, 1])).toBe(false);
  });

  it('array vs non-array returns false', () => {
    expect(structuralEqual<unknown>([1], { 0: 1, length: 1 })).toBe(false);
    expect(structuralEqual<unknown>({ 0: 1, length: 1 }, [1])).toBe(false);
  });

  it('nested arrays compare deeply', () => {
    expect(
      structuralEqual(
        [
          [1, 2],
          [3, 4],
        ],
        [
          [1, 2],
          [3, 4],
        ],
      ),
    ).toBe(true);
    expect(
      structuralEqual(
        [
          [1, 2],
          [3, 4],
        ],
        [
          [1, 2],
          [3, 5],
        ],
      ),
    ).toBe(false);
  });
});

describe('structuralEqual objects', () => {
  it('same shape', () => {
    expect(structuralEqual({ a: 1, b: 'x' }, { a: 1, b: 'x' })).toBe(true);
  });

  it('order of keys does not matter', () => {
    expect(structuralEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it('extra key on either side is unequal', () => {
    expect(structuralEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(structuralEqual({ a: 1, b: 2 }, { a: 1 })).toBe(false);
  });

  it('different value at same key', () => {
    expect(structuralEqual({ a: 1 }, { a: 2 })).toBe(false);
  });

  it('renamed key counts as unequal', () => {
    expect(structuralEqual({ a: 1 }, { b: 1 })).toBe(false);
  });

  it('nested objects recurse', () => {
    expect(structuralEqual({ a: { b: 1 } }, { a: { b: 1 } })).toBe(true);
    expect(structuralEqual({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false);
  });
});

describe('structuralEqual realistic SysCfg payloads', () => {
  const left = {
    theme: 'dark',
    slackTargets: [{ channel: '#alerts', webhookUrl: 'https://hooks.slack.com/x' }],
    appliedColumns: ['code', 'name', 'chgPct'],
  };
  const right = {
    theme: 'dark',
    slackTargets: [{ channel: '#alerts', webhookUrl: 'https://hooks.slack.com/x' }],
    appliedColumns: ['code', 'name', 'chgPct'],
  };

  it('detects identity even after fresh allocations', () => {
    expect(structuralEqual(left, right)).toBe(true);
  });

  it('detects a single column change', () => {
    expect(
      structuralEqual(left, {
        ...right,
        appliedColumns: ['code', 'chgPct', 'name'],
      }),
    ).toBe(false);
  });

  it('detects a webhook change inside a slack target', () => {
    expect(
      structuralEqual(left, {
        ...right,
        slackTargets: [{ channel: '#alerts', webhookUrl: 'https://hooks.slack.com/y' }],
      }),
    ).toBe(false);
  });
});
