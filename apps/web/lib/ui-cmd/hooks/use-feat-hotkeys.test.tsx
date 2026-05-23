import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Feat } from '../../eqty/feat.js';
import { uiRegistry } from '../registry.js';
import { useFeatHotkeys } from './use-feat-hotkeys.js';

const TEST_CELL = 'sector.rm'; // manifest entry with scope: 'MKT'

beforeEach(() => uiRegistry.__reset());
afterEach(() => uiRegistry.__reset());

describe('useFeatHotkeys', () => {
  it('binds handlers on mount and unbinds on unmount', () => {
    const handler = vi.fn();
    const { unmount } = renderHook(() =>
      useFeatHotkeys(Feat.Mkt, { 'sector.rm': handler }),
    );
    expect(uiRegistry.hasHandler(TEST_CELL)).toBe(true);
    unmount();
    expect(uiRegistry.hasHandler(TEST_CELL)).toBe(false);
  });

  it('throws when a cellId has no ui block in the registry', () => {
    expect(() => {
      renderHook(() =>
        useFeatHotkeys(Feat.Mkt, { 'does-not-exist': vi.fn() }),
      );
    }).toThrow(/unknown cell or no ui block/i);
  });

  it('throws when scope does not match the bound Feat', () => {
    expect(() => {
      renderHook(() =>
        // sector.rm has scope MKT — binding under EQ should throw.
        useFeatHotkeys(Feat.EquityChart, { 'sector.rm': vi.fn() }),
      );
    }).toThrow(/does not match feat/i);
  });

  it('dispatch routes to the bound handler', async () => {
    const handler = vi.fn();
    renderHook(() => useFeatHotkeys(Feat.Mkt, { 'sector.rm': handler }));
    await uiRegistry.dispatch('sector.rm', { id: 's1' });
    expect(handler).toHaveBeenCalledWith({ id: 's1' });
  });
});
