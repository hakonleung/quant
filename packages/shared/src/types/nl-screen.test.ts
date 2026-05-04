import { describe, expect, it } from 'vitest';

import { DslScalarSchema } from './nl-screen.js';

describe('DslScalarSchema (scale)', () => {
  it('parses scale wrapping an aggregate', () => {
    const parsed = DslScalarSchema.parse({
      kind: 'scale',
      inner: {
        kind: 'agg',
        agg: 'max',
        field: 'high_qfq',
        window: { days: 60 },
      },
      factor: '0.9',
    });
    expect(parsed.kind).toBe('scale');
  });

  it('parses nested scale', () => {
    expect(() =>
      DslScalarSchema.parse({
        kind: 'scale',
        inner: {
          kind: 'scale',
          inner: { kind: 'field', field: 'close_qfq' },
          factor: '0.5',
        },
        factor: '0.5',
      }),
    ).not.toThrow();
  });

  it('rejects scale without factor', () => {
    expect(() =>
      DslScalarSchema.parse({
        kind: 'scale',
        inner: { kind: 'field', field: 'close_qfq' },
      }),
    ).toThrow();
  });

  it('rejects scale with non-string factor (wire format is stringified Decimal)', () => {
    expect(() =>
      DslScalarSchema.parse({
        kind: 'scale',
        inner: { kind: 'field', field: 'close_qfq' },
        factor: 0.9,
      }),
    ).toThrow();
  });
});
