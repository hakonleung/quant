/**
 * FE-only global UI cells — registered at module-import time.
 *
 * These cells are intentionally NOT in the cross-process manifest:
 * they have no backend / AI dispatch path; they only mutate the
 * frontend's focus store + layout store. The keyboard engine
 * discovers them via `registerLocalCell()`.
 *
 * Cell ids are namespaced `ui.*` to keep them distinct from
 * manifest-backed cells.
 */

import { Feat, FEAT_CONFIG_MAP } from '../eqty/feat.js';
import { useLayoutStore } from '../stores/layout.store.js';
import { useSectorsStore } from '../stores/sectors.store.js';
import { ALL_SECTOR_ID, useUiStore } from '../stores/ui.store.js';
import { uiRegistry, registerLocalCell } from './registry.js';
import { useFocusStore } from './store/focus.js';
import {
  CLOSE_MODAL_CELL_ID,
  EXIT_FULLSCREEN_CELL_ID,
  HINT_TOGGLE_CELL_ID,
} from './types.js';

/**
 * Single-letter shortcut codes for module switching. Chosen so the user
 * types `g <letter>` to focus a Feat. Only Feats with a real workbench
 * presence (grid slot OR cyber bodyOverlay) are routable.
 */
const MODULE_KEYS: ReadonlyArray<readonly [letter: string, feat: Feat, label: string]> = [
  ['m', Feat.Mkt, 'Switch to market'],
  ['e', Feat.EquityChart, 'Switch to equity chart'],
  ['a', Feat.AIEq, 'Switch to AI (stock)'],
  ['s', Feat.AISec, 'Switch to AI (sector)'],
  ['u', Feat.UsrMain, 'Switch to user'],
  ['t', Feat.Terminal, 'Switch to terminal'],
  ['y', Feat.SysMain, 'Switch to system'],
];

function moduleCellId(feat: Feat): string {
  return `ui.go-${feat.toLowerCase().replace(/\./g, '-')}`;
}

function registerModuleCells(): void {
  for (const [letter, feat, label] of MODULE_KEYS) {
    const id = moduleCellId(feat);
    registerLocalCell(id, {
      scope: 'global',
      keys: [`g ${letter}`],
      label,
      group: 'nav',
    });
    uiRegistry.bind(id, () => {
      useFocusStore.getState().setActive(feat);
    });
  }
}

function registerHintCell(): void {
  registerLocalCell(HINT_TOGGLE_CELL_ID, {
    scope: 'global',
    keys: ['?'],
    label: 'Toggle keyboard hint',
    group: 'view',
  });
  uiRegistry.bind(HINT_TOGGLE_CELL_ID, () => {
    useFocusStore.getState().toggleHintOpen();
  });
}

function registerExitFullscreenCell(): void {
  registerLocalCell(EXIT_FULLSCREEN_CELL_ID, {
    scope: 'global',
    label: 'Exit fullscreen',
    group: 'view',
  });
  uiRegistry.bind(EXIT_FULLSCREEN_CELL_ID, () => {
    const focus = useFocusStore.getState();
    const f = focus.fullscreen;
    if (f === null) return;
    focus.setFullscreen(null);
    useLayoutStore.getState().setFeatViewMode(f, 'normal');
  });
}

function registerCloseModalCell(): void {
  registerLocalCell(CLOSE_MODAL_CELL_ID, {
    scope: 'global',
    label: 'Close modal',
    group: 'view',
  });
  uiRegistry.bind(CLOSE_MODAL_CELL_ID, () => {
    useFocusStore.getState().setModalOpen(false);
  });
}

function registerViewModeCells(): void {
  // z f → toggle fullscreen on active Feat
  registerLocalCell('ui.toggle-fullscreen', {
    scope: 'global',
    keys: ['z f'],
    label: 'Toggle fullscreen',
    group: 'view',
  });
  uiRegistry.bind('ui.toggle-fullscreen', () => {
    const focus = useFocusStore.getState();
    const f = focus.activeFeat;
    if (f === null) return;
    const layout = useLayoutStore.getState();
    const current = layout.featViewMode[f];
    if (current === 'fullscreen') {
      focus.setFullscreen(null);
      layout.setFeatViewMode(f, 'normal');
    } else {
      focus.setFullscreen(f);
      layout.setFeatViewMode(f, 'fullscreen');
    }
  });

  // z m → toggle minimize on active Feat
  registerLocalCell('ui.toggle-minimize', {
    scope: 'global',
    keys: ['z m'],
    label: 'Toggle minimize',
    group: 'view',
  });
  uiRegistry.bind('ui.toggle-minimize', () => {
    const f = useFocusStore.getState().activeFeat;
    if (f === null) return;
    const layout = useLayoutStore.getState();
    const current = layout.featViewMode[f];
    const next = current === 'minimized' ? 'normal' : 'minimized';
    layout.setFeatViewMode(f, next);
  });
}

/**
 * MKT-scoped sector navigation. The ordered list mirrors what the chip
 * swiper renders (ALL pseudo-sector first, then user sectors, then
 * dynamic sectors) so j/k visit chips in visual order.
 */
function orderedSectorIds(): readonly string[] {
  const sectors = useSectorsStore.getState().sectors;
  const userRows = sectors.filter((r) => r.kind === 'user').map((r) => r.id);
  const dynRows = sectors.filter((r) => r.kind === 'dynamic').map((r) => r.id);
  return [ALL_SECTOR_ID, ...userRows, ...dynRows];
}

function advanceSector(delta: number): void {
  const ordered = orderedSectorIds();
  if (ordered.length === 0) return;
  const cur = useUiStore.getState().activeSectorId;
  const idx = ordered.indexOf(cur);
  // Wrap-around: when current is missing (e.g. just deleted) fall to ALL.
  const base = idx === -1 ? 0 : idx;
  const next = (base + delta + ordered.length) % ordered.length;
  const nextId = ordered[next];
  if (nextId === undefined) return;
  useUiStore.getState().setActiveSector(nextId);
}

function registerSectorNavCells(): void {
  registerLocalCell('ui.sector-next', {
    scope: Feat.Mkt,
    keys: ['j'],
    label: 'Next sector',
    group: 'nav',
  });
  uiRegistry.bind('ui.sector-next', () => advanceSector(1));

  registerLocalCell('ui.sector-prev', {
    scope: Feat.Mkt,
    keys: ['k'],
    label: 'Previous sector',
    group: 'nav',
  });
  uiRegistry.bind('ui.sector-prev', () => advanceSector(-1));
}

let installed = false;

/**
 * Idempotent registration entry point. Call once from `providers.tsx`
 * (or any client-only top-level effect) before mounting `<UiCmdEngine />`.
 */
export function installGlobalCells(): void {
  if (installed) return;
  installed = true;
  registerHintCell();
  registerExitFullscreenCell();
  registerCloseModalCell();
  registerModuleCells();
  registerViewModeCells();
  registerSectorNavCells();
}

/** Test-only escape hatch. */
export function __resetGlobalCellsForTest(): void {
  installed = false;
}

/** Convenience reference for unit tests + Phase 2.5 hint window. */
export const MODULE_HOTKEY_MAP: ReadonlyArray<readonly [string, Feat]> = MODULE_KEYS.map(
  ([k, f]) => [k, f] as const,
);

// Quiet TS unused-import: FEAT_CONFIG_MAP referenced for documentation only.
void FEAT_CONFIG_MAP;
