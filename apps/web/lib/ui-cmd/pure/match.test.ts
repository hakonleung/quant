import { describe, expect, it } from 'vitest';

import type { UiBinding, UiCtx } from '../types.js';
import { matchSequence } from './match.js';

function binding(
  cellId: string,
  scope: string,
  seq: readonly string[],
  when?: (ctx: UiCtx) => boolean,
): UiBinding {
  return {
    cellId,
    seq,
    ui: {
      scope,
      keys: [seq.join(' ')],
      label: cellId,
      group: 'action',
      ...(when !== undefined ? { when } : {}),
    },
  };
}

const ctx = (over: Partial<UiCtx> = {}): UiCtx => ({
  activeFeat: null,
  fullscreen: null,
  subFocus: [],
  modalOpen: false, hintOpen: false,
  ...over,
});

describe('matchSequence', () => {
  it('exact match within global scope', () => {
    const r = matchSequence(['?'], [binding('hint', 'global', ['?'])], ctx());
    expect(r).toEqual({ kind: 'exact', cellId: 'hint' });
  });

  it('partial match for prefix', () => {
    const r = matchSequence(['g'], [binding('go-mkt', 'global', ['g', 'm'])], ctx());
    expect(r).toEqual({ kind: 'partial' });
  });

  it('exact match for two-key sequence', () => {
    const r = matchSequence(['g', 'm'], [binding('go-mkt', 'global', ['g', 'm'])], ctx());
    expect(r).toEqual({ kind: 'exact', cellId: 'go-mkt' });
  });

  it('returns none when no binding applies', () => {
    expect(matchSequence(['x'], [], ctx())).toEqual({ kind: 'none' });
  });

  it('empty buffer → none', () => {
    expect(matchSequence([], [binding('go-mkt', 'global', ['g'])], ctx())).toEqual({
      kind: 'none',
    });
  });

  it('skips bindings whose scope is not active', () => {
    const b = binding('mkt-d', 'MKT', ['d']);
    expect(matchSequence(['d'], [b], ctx())).toEqual({ kind: 'none' });
    expect(matchSequence(['d'], [b], ctx({ activeFeat: 'MKT' }))).toEqual({
      kind: 'exact',
      cellId: 'mkt-d',
    });
  });

  it('skips bindings whose when() predicate returns false', () => {
    const b = binding('mkt-d', 'MKT', ['d'], (c) => c.modalOpen);
    expect(matchSequence(['d'], [b], ctx({ activeFeat: 'MKT' }))).toEqual({ kind: 'none' });
    expect(
      matchSequence(['d'], [b], ctx({ activeFeat: 'MKT', modalOpen: true, hintOpen: false })),
    ).toEqual({ kind: 'exact', cellId: 'mkt-d' });
  });

  it('sub-scope shadows parent on identical sequence', () => {
    const parent = binding('mkt-d', 'MKT', ['d']);
    const sub = binding('mkt-sector-d', 'MKT.sector', ['d']);
    const r = matchSequence(
      ['d'],
      [parent, sub],
      ctx({ activeFeat: 'MKT', subFocus: ['sector'] }),
    );
    expect(r).toEqual({ kind: 'exact', cellId: 'mkt-sector-d' });
  });

  it('parent wins when sub-scope is not active', () => {
    const parent = binding('mkt-d', 'MKT', ['d']);
    const sub = binding('mkt-sector-d', 'MKT.sector', ['d']);
    const r = matchSequence(['d'], [parent, sub], ctx({ activeFeat: 'MKT' }));
    expect(r).toEqual({ kind: 'exact', cellId: 'mkt-d' });
  });
});
