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

import { putSectors } from '../api/sectors.js';
import { Feat, FEAT_CONFIG_MAP } from '../eqty/feat.js';
import { invokeInstruction } from '../instructions/client.js';
import { useLayoutStore } from '../stores/layout.store.js';
import { useSectorsStore } from '../stores/sectors.store.js';
import { ALL_SECTOR_ID, useUiStore } from '../stores/ui.store.js';
import { confirmGuard, ConfirmCancelled } from './confirm/store.js';
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

/**
 * Stocks in the currently-active sector, in the order the equity list
 * renders them. Defers to the universe (all codes) when active sector
 * is the ALL pseudo-sector.
 */
function currentSectorCodes(): readonly string[] {
  const active = useUiStore.getState().activeSectorId;
  if (active === ALL_SECTOR_ID) {
    // ALL: no in-list ordering at this layer; the actual stock list
    // pages do their own filtering / sorting. Bail to an empty list
    // rather than guess — the user already has 'g s'-style global nav
    // for switching modules, and stock-level nav inside ALL is rarely
    // useful.
    return [];
  }
  const sector = useSectorsStore.getState().sectors.find((s) => s.id === active);
  return sector?.codes ?? [];
}

function advanceStock(delta: number): void {
  const codes = currentSectorCodes();
  if (codes.length === 0) return;
  const cur = useUiStore.getState().focusCode;
  const idx = cur === null ? -1 : codes.indexOf(cur);
  // No focus yet → land on the natural endpoint for the direction.
  // J (delta=+1) → first row; K (delta=-1) → last row.
  let next: number;
  if (idx === -1) next = delta > 0 ? 0 : codes.length - 1;
  else next = (idx + delta + codes.length) % codes.length;
  const nextCode = codes[next];
  if (nextCode === undefined) return;
  useUiStore.getState().setFocusCode(nextCode);
}

function registerStockNavCells(): void {
  registerLocalCell('ui.stock-next', {
    scope: Feat.Mkt,
    keys: ['J'],
    label: 'Next stock',
    group: 'nav',
  });
  uiRegistry.bind('ui.stock-next', () => advanceStock(1));

  registerLocalCell('ui.stock-prev', {
    scope: Feat.Mkt,
    keys: ['K'],
    label: 'Previous stock',
    group: 'nav',
  });
  uiRegistry.bind('ui.stock-prev', () => advanceStock(-1));
}

/**
 * Local cell registered without a default handler — Feat-internal UI
 * state mutators (open form / dialog) need a Feat-bound handler via
 * `useFeatHotkeys`. We declare the cell metadata centrally so the hint
 * window sees it under the right scope, but leave binding to the Feat.
 */
/**
 * AI.SEC `R` → analyze.sector(id=activeSectorId). Manifest cell with
 * `doubleConfirm: llm`; the handler fires `confirmGuard` manually
 * because useCommand's auto-confirm gate only kicks in on the BE-
 * fallback path (no local handler bound). Skip the ALL pseudo-sector.
 */
function registerAnalyzeSectorBinding(): void {
  uiRegistry.bind('analyze.sector', async (args) => {
    const argsObj = (args ?? {}) as { id?: string; confirm?: boolean };
    const id = argsObj.id ?? useUiStore.getState().activeSectorId;
    if (id === ALL_SECTOR_ID) return;
    if (argsObj.confirm !== true) {
      try {
        await confirmGuard({
          title: 'analyze sector',
          message: `Run sector sentiment analysis for ${id}? This triggers a paid LLM call.`,
          confirmLabel: 'PROCEED',
        });
      } catch (e: unknown) {
        if (e instanceof ConfirmCancelled) return;
        throw e;
      }
    }
    await invokeInstruction(
      'analyze.sector' as never,
      { id, confirm: true } as never,
    );
  });
}

function registerOpenNewSectorCell(): void {
  registerLocalCell('ui.sector-new-open', {
    scope: Feat.Mkt,
    keys: ['N'],
    label: 'New sector',
    group: 'edit',
  });
  // Handler bound by FeatMkt via useFeatHotkeys.
}

function registerRemoveStockCell(): void {
  registerLocalCell('ui.sector-remove-stock', {
    scope: Feat.Mkt,
    keys: ['X'],
    label: 'Remove focused stock from sector',
    group: 'action',
  });
  uiRegistry.bind('ui.sector-remove-stock', async () => {
    const activeId = useUiStore.getState().activeSectorId;
    if (activeId === ALL_SECTOR_ID) return;
    const focusCode = useUiStore.getState().focusCode;
    if (focusCode === null) return;
    const sectors = useSectorsStore.getState().sectors;
    const target = sectors.find((s) => s.id === activeId);
    if (target === undefined) return;
    if (!target.codes.includes(focusCode)) return;
    try {
      await confirmGuard({
        title: 'remove stock',
        message: `Remove ${focusCode} from ${target.name}? Sector membership will be updated.`,
        confirmLabel: 'REMOVE',
      });
    } catch (e: unknown) {
      if (e instanceof ConfirmCancelled) return;
      throw e;
    }
    const updated = {
      ...target,
      codes: target.codes.filter((c) => c !== focusCode),
      count: target.codes.length - 1,
    };
    const nextList = sectors.map((s) => (s.id === activeId ? updated : s));
    const persisted = await putSectors(nextList);
    useSectorsStore.getState().setSectors(persisted);
    // Advance focusCode to a neighbour or clear it.
    const remaining = updated.codes;
    useUiStore.getState().setFocusCode(remaining[0] ?? null);
  });
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
 * Idempotent registration entry point.
 *
 * **Called as a module-level side effect at the bottom of this file** so
 * registration completes before any component renders. The earlier
 * approach of calling it from a `useEffect` in `providers.tsx` raced
 * with child components: React fires child `useEffect`s before parent
 * `useEffect`s, so `useFeatHotkeys` (in e.g. `FeatMkt`) ran before the
 * provider effect that registered the cells, throwing
 * `unknown cell or no ui block`. Module-time registration eliminates
 * that race while staying idempotent for HMR / fast refresh.
 *
 * Safe at module import time: registration only touches in-memory maps
 * and zustand stores; no DOM / window access. SSR-safe.
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
  registerStockNavCells();
  registerRemoveStockCell();
  registerOpenNewSectorCell();
  registerAnalyzeSectorBinding();
}

/** Test-only escape hatch. */
export function __resetGlobalCellsForTest(): void {
  installed = false;
}

// Module-time registration — runs once on first import, before any
// component that imports the ui-cmd surface can render.
installGlobalCells();

/** Convenience reference for unit tests + Phase 2.5 hint window. */
export const MODULE_HOTKEY_MAP: ReadonlyArray<readonly [string, Feat]> = MODULE_KEYS.map(
  ([k, f]) => [k, f] as const,
);

// Quiet TS unused-import: FEAT_CONFIG_MAP referenced for documentation only.
void FEAT_CONFIG_MAP;
