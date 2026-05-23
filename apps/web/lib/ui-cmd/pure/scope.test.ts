import { describe, expect, it } from 'vitest';

import type { UiCtx } from '../types.js';
import { isScopeActive, scopeSpecificity } from './scope.js';

const baseCtx: UiCtx = {
  activeFeat: null,
  fullscreen: null,
  subFocus: [],
  modalOpen: false, hintOpen: false,
};

describe('isScopeActive', () => {
  it('global is always active', () => {
    expect(isScopeActive('global', baseCtx)).toBe(true);
    expect(isScopeActive('global', { ...baseCtx, activeFeat: 'MKT' })).toBe(true);
  });

  it('Feat scope requires matching activeFeat', () => {
    expect(isScopeActive('MKT', baseCtx)).toBe(false);
    expect(isScopeActive('MKT', { ...baseCtx, activeFeat: 'MKT' })).toBe(true);
    expect(isScopeActive('MKT', { ...baseCtx, activeFeat: 'EQ' })).toBe(false);
  });

  it('sub-scope requires Feat match AND sub on top of stack', () => {
    expect(isScopeActive('MKT.sector', { ...baseCtx, activeFeat: 'MKT' })).toBe(false);
    expect(
      isScopeActive('MKT.sector', { ...baseCtx, activeFeat: 'MKT', subFocus: ['sector'] }),
    ).toBe(true);
    expect(
      isScopeActive('MKT.sector', { ...baseCtx, activeFeat: 'MKT', subFocus: ['stock'] }),
    ).toBe(false);
    expect(
      isScopeActive('MKT.sector', { ...baseCtx, activeFeat: 'EQ', subFocus: ['sector'] }),
    ).toBe(false);
  });

  it('sub-focus stack — only the top matters', () => {
    expect(
      isScopeActive('MKT.stock', {
        ...baseCtx,
        activeFeat: 'MKT',
        subFocus: ['sector', 'stock'],
      }),
    ).toBe(true);
    expect(
      isScopeActive('MKT.sector', {
        ...baseCtx,
        activeFeat: 'MKT',
        subFocus: ['sector', 'stock'],
      }),
    ).toBe(false);
  });
});

describe('scopeSpecificity', () => {
  it('global = 0, Feat = 1, sub-scope = 2', () => {
    expect(scopeSpecificity('global')).toBe(0);
    expect(scopeSpecificity('MKT')).toBe(1);
    expect(scopeSpecificity('MKT.sector')).toBe(2);
  });
});
