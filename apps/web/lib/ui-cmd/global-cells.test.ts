import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Feat } from '../eqty/feat.js';
import { useLayoutStore } from '../stores/layout.store.js';
import { useSectorsStore, type Sector } from '../stores/sectors.store.js';
import { ALL_SECTOR_ID, useUiStore } from '../stores/ui.store.js';
import {
  __resetGlobalCellsForTest,
  installGlobalCells,
  MODULE_HOTKEY_MAP,
} from './global-cells.js';
import { uiRegistry } from './registry.js';
import { useFocusStore } from './store/focus.js';
import { HINT_TOGGLE_CELL_ID } from './types.js';

const sectorFixture = (
  id: string,
  kind: 'user' | 'dynamic',
  name: string = id,
): Sector => ({
  id,
  name,
  kind,
  market: 'a',
  count: 0,
  meta: '',
  chgPct: null,
  codes: [],
  createdBy: 'tester',
  published: false,
});

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
  it('hint toggle flips SCOPE pane mode', async () => {
    // SCOPE pane defaults to `minimized` (FEAT_CONFIG_MAP). The hint
    // cell toggles it between `minimized` and `normal`.
    expect(useLayoutStore.getState().featViewMode[Feat.Scope] ?? 'minimized').toBe('minimized');
    await uiRegistry.dispatch(HINT_TOGGLE_CELL_ID);
    expect(useLayoutStore.getState().featViewMode[Feat.Scope]).toBe('normal');
    await uiRegistry.dispatch(HINT_TOGGLE_CELL_ID);
    expect(useLayoutStore.getState().featViewMode[Feat.Scope]).toBe('minimized');
  });
});

describe('installGlobalCells is idempotent', () => {
  it('second call does not double-register', () => {
    installGlobalCells();
    installGlobalCells();
    expect(uiRegistry.hasHandler('ui.go-mkt')).toBe(true);
  });
});

describe('global cells — stock navigation (MKT scope)', () => {
  it('J advances focusCode through the active sector codes with wrap', async () => {
    useSectorsStore.setState({
      sectors: [
        {
          ...sectorFixture('s1', 'user'),
          codes: ['600519', '000001', '300750'],
          count: 3,
        },
      ],
    });
    useUiStore.setState({ activeSectorId: 's1', focusCode: null });
    await uiRegistry.dispatch('ui.stock-next');
    expect(useUiStore.getState().focusCode).toBe('600519');
    await uiRegistry.dispatch('ui.stock-next');
    expect(useUiStore.getState().focusCode).toBe('000001');
    await uiRegistry.dispatch('ui.stock-next');
    expect(useUiStore.getState().focusCode).toBe('300750');
    await uiRegistry.dispatch('ui.stock-next');
    expect(useUiStore.getState().focusCode).toBe('600519');
  });

  it('K walks backwards through the active sector codes', async () => {
    useSectorsStore.setState({
      sectors: [
        {
          ...sectorFixture('s1', 'user'),
          codes: ['600519', '000001', '300750'],
          count: 3,
        },
      ],
    });
    useUiStore.setState({ activeSectorId: 's1', focusCode: '600519' });
    await uiRegistry.dispatch('ui.stock-prev');
    expect(useUiStore.getState().focusCode).toBe('300750');
  });

  it('J no-ops when active sector is ALL', async () => {
    useUiStore.setState({ activeSectorId: ALL_SECTOR_ID, focusCode: null });
    await uiRegistry.dispatch('ui.stock-next');
    expect(useUiStore.getState().focusCode).toBeNull();
  });
});

describe('global cells — sector navigation (MKT scope)', () => {
  it('j advances through ordered list (ALL → user → dynamic) with wrap-around', async () => {
    useSectorsStore.setState({
      sectors: [sectorFixture('s1', 'user'), sectorFixture('d1', 'dynamic')],
    });
    useUiStore.setState({ activeSectorId: ALL_SECTOR_ID });
    await uiRegistry.dispatch('ui.sector-next');
    expect(useUiStore.getState().activeSectorId).toBe('s1');
    await uiRegistry.dispatch('ui.sector-next');
    expect(useUiStore.getState().activeSectorId).toBe('d1');
    await uiRegistry.dispatch('ui.sector-next');
    expect(useUiStore.getState().activeSectorId).toBe(ALL_SECTOR_ID);
  });

  it('k walks backwards with wrap-around', async () => {
    useSectorsStore.setState({
      sectors: [sectorFixture('s1', 'user'), sectorFixture('d1', 'dynamic')],
    });
    useUiStore.setState({ activeSectorId: ALL_SECTOR_ID });
    await uiRegistry.dispatch('ui.sector-prev');
    expect(useUiStore.getState().activeSectorId).toBe('d1');
    await uiRegistry.dispatch('ui.sector-prev');
    expect(useUiStore.getState().activeSectorId).toBe('s1');
    await uiRegistry.dispatch('ui.sector-prev');
    expect(useUiStore.getState().activeSectorId).toBe(ALL_SECTOR_ID);
  });

  it('lands on ALL when the current sector was removed mid-navigation', async () => {
    useSectorsStore.setState({ sectors: [sectorFixture('s1', 'user')] });
    useUiStore.setState({ activeSectorId: 'gone' });
    await uiRegistry.dispatch('ui.sector-next');
    // ordered = [ALL, s1]; missing current → base=0, delta=+1 → s1
    expect(useUiStore.getState().activeSectorId).toBe('s1');
  });

  it('only visible under MKT scope', () => {
    const globalCtx = {
      activeFeat: null,
      fullscreen: null,
      subFocus: [],
      modalOpen: false,
      hintOpen: false,
    };
    const visibleGlobal = uiRegistry
      .visible(globalCtx)
      .filter((b) => b.cellId === 'ui.sector-next');
    expect(visibleGlobal.length).toBe(0);
    const mktCtx = { ...globalCtx, activeFeat: Feat.Mkt };
    const visibleMkt = uiRegistry
      .visible(mktCtx)
      .filter((b) => b.cellId === 'ui.sector-next');
    expect(visibleMkt.length).toBe(1);
  });
});
