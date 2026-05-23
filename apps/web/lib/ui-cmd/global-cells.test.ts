import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Feat } from '../eqty/feat.js';
import { useLayoutStore } from '../stores/layout.store.js';
import {
  __resetGlobalCellsForTest,
  installGlobalCells,
  MODULE_HOTKEY_MAP,
} from './global-cells.js';
import { uiRegistry } from './registry.js';
import { useFocusStore } from './store/focus.js';
import { HINT_TOGGLE_CELL_ID } from './types.js';

beforeEach(() => {
  uiRegistry.__reset();
  __resetGlobalCellsForTest();
  useFocusStore.setState({
    activeFeat: null,
    fullscreen: null,
    subFocus: [],
    modalOpen: false, hintOpen: false,
  });
  installGlobalCells();
});

afterEach(() => {
  uiRegistry.__reset();
  __resetGlobalCellsForTest();
});

describe('global cells — module navigation', () => {
  it('every MODULE_HOTKEY entry registers a binding under `g <letter>`', () => {
    const ctx = {
      activeFeat: null,
      fullscreen: null,
      subFocus: [],
      modalOpen: false, hintOpen: false,
    };
    const bindings = uiRegistry.visible(ctx);
    for (const [letter, feat] of MODULE_HOTKEY_MAP) {
      const seq = ['g', letter];
      const hit = bindings.find(
        (b) => b.seq.length === 2 && b.seq[0] === seq[0] && b.seq[1] === seq[1],
      );
      expect(hit, `binding for ${feat}`).toBeDefined();
    }
  });

  it('dispatching ui.go-mkt sets activeFeat to Feat.Mkt', async () => {
    await uiRegistry.dispatch('ui.go-mkt');
    expect(useFocusStore.getState().activeFeat).toBe(Feat.Mkt);
  });

  it('dispatching ui.go-eq sets activeFeat to Feat.EquityChart', async () => {
    await uiRegistry.dispatch('ui.go-eq');
    expect(useFocusStore.getState().activeFeat).toBe(Feat.EquityChart);
  });
});

describe('global cells — view-mode toggles', () => {
  it('z f toggles fullscreen for the active Feat', async () => {
    useFocusStore.getState().setActive(Feat.Mkt);
    await uiRegistry.dispatch('ui.toggle-fullscreen');
    expect(useFocusStore.getState().fullscreen).toBe(Feat.Mkt);
    expect(useLayoutStore.getState().featViewMode[Feat.Mkt]).toBe('fullscreen');
    await uiRegistry.dispatch('ui.toggle-fullscreen');
    expect(useFocusStore.getState().fullscreen).toBeNull();
    expect(useLayoutStore.getState().featViewMode[Feat.Mkt]).toBe('normal');
  });

  it('z m toggles minimize for the active Feat', async () => {
    useFocusStore.getState().setActive(Feat.Mkt);
    useLayoutStore.getState().setFeatViewMode(Feat.Mkt, 'normal');
    await uiRegistry.dispatch('ui.toggle-minimize');
    expect(useLayoutStore.getState().featViewMode[Feat.Mkt]).toBe('minimized');
    await uiRegistry.dispatch('ui.toggle-minimize');
    expect(useLayoutStore.getState().featViewMode[Feat.Mkt]).toBe('normal');
  });

  it('z f / z m no-op when no Feat is active', async () => {
    expect(useFocusStore.getState().activeFeat).toBeNull();
    await uiRegistry.dispatch('ui.toggle-fullscreen');
    expect(useFocusStore.getState().fullscreen).toBeNull();
  });
});

describe('global cells — special keys', () => {
  it('hint toggle flips hintOpen', async () => {
    expect(useFocusStore.getState().hintOpen).toBe(false);
    await uiRegistry.dispatch(HINT_TOGGLE_CELL_ID);
    expect(useFocusStore.getState().hintOpen).toBe(true);
    await uiRegistry.dispatch(HINT_TOGGLE_CELL_ID);
    expect(useFocusStore.getState().hintOpen).toBe(false);
  });
});

describe('installGlobalCells is idempotent', () => {
  it('second call does not double-register', () => {
    installGlobalCells();
    installGlobalCells();
    expect(uiRegistry.hasHandler('ui.go-mkt')).toBe(true);
  });
});
