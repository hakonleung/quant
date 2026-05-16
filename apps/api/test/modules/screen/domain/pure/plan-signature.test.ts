/**
 * Tests for `planSignature`. Lock the canonical JSON form so the hash
 * stays byte-identical with what the Py implementation produced (cache
 * keys persist across the migration).
 */

import type { RankSpecView, ScreenPlanAst } from '@quant/shared';
import { createHash } from 'node:crypto';

import { planSignature } from '../../../../../src/modules/screen/domain/pure/plan-signature.js';

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf-8').digest('hex');
}

describe('planSignature', () => {
  it('signs a Compare plan with the Py-canonical shape', () => {
    const plan: ScreenPlanAst = {
      asof: '2026-05-16',
      expr: {
        kind: 'compare',
        op: 'gt',
        left: { kind: 'field', field: 'close_qfq' },
        right: { kind: 'const', value: '10' },
      },
    };
    // Py canonical: keys sorted, no whitespace.
    const expectedCanonical = JSON.stringify({
      asof: '2026-05-16',
      expr: {
        left: { field: 'close_qfq' },
        op: 'gt',
        right: { const: '10' },
      },
    })
      .split('')
      .join(''); // already canonical (sort_keys + no whitespace)
    expect(planSignature(plan)).toBe(
      sha256Hex(
        '{"asof":"2026-05-16","expr":{"left":{"field":"close_qfq"},"op":"gt","right":{"const":"10"}}}',
      ),
    );
    // Sanity: shape matches.
    expect(expectedCanonical).toBe(
      '{"asof":"2026-05-16","expr":{"left":{"field":"close_qfq"},"op":"gt","right":{"const":"10"}}}',
    );
  });

  it('different rank → different signature', () => {
    const plan: ScreenPlanAst = {
      asof: '2026-05-16',
      expr: {
        kind: 'compare',
        op: 'gt',
        left: { kind: 'field', field: 'close_qfq' },
        right: { kind: 'const', value: '10' },
      },
    };
    const r1: RankSpecView = {
      metric: { kind: 'field', field: 'volume' },
      order: 'desc',
      topN: 10,
    };
    const r2: RankSpecView = {
      metric: { kind: 'field', field: 'volume' },
      order: 'asc',
      topN: 10,
    };
    expect(planSignature(plan, r1)).not.toBe(planSignature(plan, r2));
  });

  it('deterministic across runs', () => {
    const plan: ScreenPlanAst = {
      asof: '2026-05-16',
      expr: {
        kind: 'for_all',
        window: { days: 5 },
        predicate: {
          kind: 'compare',
          op: 'gt',
          left: { kind: 'field', field: 'volume' },
          right: { kind: 'const', value: '100' },
        },
      },
    };
    expect(planSignature(plan)).toBe(planSignature(plan));
  });
});
