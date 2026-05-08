import { describe, expect, it } from 'vitest';

import { computeMembershipDiff, initialMembershipSelection } from './sector-membership.js';

interface S {
  readonly id: string;
  readonly kind: 'user' | 'dynamic';
  readonly codes: readonly string[];
}

const sectors: readonly S[] = [
  { id: 's1', kind: 'user', codes: ['600519', '000001'] },
  { id: 's2', kind: 'user', codes: ['600519'] },
  { id: 's3', kind: 'user', codes: [] },
  { id: 'd1', kind: 'dynamic', codes: ['600519'] },
];

describe('initialMembershipSelection', () => {
  it('returns the user sectors that already contain the code (golden)', () => {
    const r = initialMembershipSelection(sectors, '600519');
    expect(r).toEqual(new Set(['s1', 's2']));
  });

  it('skips dynamic sectors (boundary: kind filter)', () => {
    const r = initialMembershipSelection(sectors, '600519');
    expect(r.has('d1')).toBe(false);
  });

  it('returns an empty set for codes nobody owns (boundary)', () => {
    const r = initialMembershipSelection(sectors, '888888');
    expect(r.size).toBe(0);
  });
});

describe('computeMembershipDiff', () => {
  it('produces no diff when selection equals current memberships (invariant)', () => {
    const initial = initialMembershipSelection(sectors, '600519');
    const diff = computeMembershipDiff(sectors, '600519', initial);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  it('emits an add when a previously-unchecked sector is selected (golden add)', () => {
    const diff = computeMembershipDiff(sectors, '600519', new Set(['s1', 's2', 's3']));
    expect(diff.added.map((a) => a.sector.id)).toEqual(['s3']);
    expect(diff.added[0]!.nextCodes).toEqual(['600519']);
    expect(diff.removed).toHaveLength(0);
  });

  it('emits a remove when a previously-checked sector is unchecked (golden remove)', () => {
    const diff = computeMembershipDiff(sectors, '600519', new Set(['s1']));
    expect(diff.added).toHaveLength(0);
    expect(diff.removed.map((r) => r.sector.id)).toEqual(['s2']);
    expect(diff.removed[0]!.nextCodes).toEqual([]);
  });

  it('handles a mixed add+remove diff in one pass', () => {
    // Currently in s1, s2 — switch to s2, s3 (add s3, remove s1).
    const diff = computeMembershipDiff(sectors, '600519', new Set(['s2', 's3']));
    expect(diff.added.map((a) => a.sector.id)).toEqual(['s3']);
    expect(diff.removed.map((r) => r.sector.id)).toEqual(['s1']);
    // s1 retains '000001' after removing '600519'
    expect(diff.removed[0]!.nextCodes).toEqual(['000001']);
  });

  it('ignores dynamic sectors even when the selection contains them', () => {
    const diff = computeMembershipDiff(sectors, '600519', new Set(['d1']));
    // d1 cannot be touched; s1/s2 lose membership; nothing is added.
    expect(diff.added).toHaveLength(0);
    expect(diff.removed.map((r) => r.sector.id).sort()).toEqual(['s1', 's2']);
  });

  it('preserves member order when adding (regression: append at end)', () => {
    const r = computeMembershipDiff(sectors, '600519', new Set(['s1', 's2', 's3']));
    expect(r.added[0]!.nextCodes).toEqual(['600519']);
  });
});
