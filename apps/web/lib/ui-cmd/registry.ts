/**
 * UI command registry.
 *
 * Single source of truth for which manifest entries have a UI affordance.
 * Reads `COMMAND_MANIFEST` at construction time; parses each entry's
 * `ui.keys` into canonical `KeySequence`s; exposes runtime handler
 * binding for Feat components.
 *
 * Free of React / zustand / fetch — pure module that the engine and
 * hooks talk to imperatively.
 */

import { COMMAND_MANIFEST } from '@quant/shared';

import { parseSequence } from './pure/parse-keys.js';
import { isScopeActive } from './pure/scope.js';
import type { Scope, UiBinding, UiCtx } from './types.js';

type Handler = (args?: unknown) => void | Promise<void>;

interface InternalEntry {
  readonly binding: UiBinding;
  handler: Handler | null;
}

/**
 * Build the canonical entry table from the shared manifest.
 *
 * Cells without a `ui` block are skipped. Each `ui.keys[]` entry yields
 * one `UiBinding` (so a single cell with `keys: ['g m', '?']` produces
 * two bindings sharing the same cellId).
 */
/**
 * Locally-registered FE-only cells (navigation, view-mode toggles, hint
 * window, modal close). Not part of the cross-process manifest. Filled
 * by `registerLocal()` at module-import time from `global-cells.ts`.
 */
const LOCAL_CELLS = new Map<string, import('./types.js').UiCellBlock>();

export function registerLocalCell(cellId: string, ui: import('./types.js').UiCellBlock): void {
  LOCAL_CELLS.set(cellId, ui);
  appendToIndex(cellId, ui);
}

function appendToIndex(cellId: string, ui: import('./types.js').UiCellBlock): void {
  // Replace any existing binding for this cellId (handlers preserved
  // via `entries.get(cellId)?.[i]?.handler` only when sequence count
  // matches; the simple replace path is correct because callers always
  // re-bind right after registerLocalCell).
  const newEntries: InternalEntry[] = [];
  const keys = ui.keys ?? [];
  if (keys.length === 0) {
    newEntries.push({ binding: { cellId, seq: [], ui }, handler: null });
  } else {
    for (const raw of keys) {
      newEntries.push({ binding: { cellId, seq: parseSequence(raw), ui }, handler: null });
    }
  }
  entries.set(cellId, newEntries);
}

function buildEntries(): Map<string, InternalEntry[]> {
  const out = new Map<string, InternalEntry[]>();
  const all: Array<{ id: string; ui: import('./types.js').UiCellBlock }> = [];
  for (const entry of COMMAND_MANIFEST) {
    if (entry.ui !== undefined) all.push({ id: entry.id, ui: entry.ui });
  }
  for (const [id, ui] of LOCAL_CELLS) all.push({ id, ui });
  for (const { id: entryId, ui } of all) {
    const entry = { id: entryId };
    const keys = ui.keys ?? [];
    if (keys.length === 0) {
      // Mouse-only cell — still tracked so <CmdButton> can dispatch.
      const e: InternalEntry = {
        binding: { cellId: entry.id, seq: [], ui },
        handler: null,
      };
      const list = out.get(entry.id) ?? [];
      list.push(e);
      out.set(entry.id, list);
      continue;
    }
    for (const raw of keys) {
      const seq = parseSequence(raw);
      const e: InternalEntry = {
        binding: { cellId: entry.id, seq, ui },
        handler: null,
      };
      const list = out.get(entry.id) ?? [];
      list.push(e);
      out.set(entry.id, list);
    }
  }
  return out;
}

let entries: Map<string, InternalEntry[]> = buildEntries();

function allEntries(): InternalEntry[] {
  const out: InternalEntry[] = [];
  for (const list of entries.values()) for (const e of list) out.push(e);
  return out;
}

export const uiRegistry = {
  /** All bindings active under `ctx`. Filtered by scope; predicates run at match time. */
  visible(ctx: UiCtx): readonly UiBinding[] {
    return allEntries()
      .filter((e) => isScopeActive(e.binding.ui.scope as Scope, ctx))
      .map((e) => e.binding);
  },

  /**
   * All bindings, regardless of scope — needed for build-time collision
   * checks and hint-window rendering when the user wants a global list.
   */
  all(): readonly UiBinding[] {
    return allEntries().map((e) => e.binding);
  },

  /**
   * Register the runtime handler for a cell id. Returns an `unbind` fn.
   * Calling `bind` for a cell with no `ui` block throws in dev.
   */
  bind(cellId: string, handler: Handler): () => void {
    const list = entries.get(cellId);
    if (list === undefined || list.length === 0) {
      throw new Error(`uiRegistry.bind: unknown cell or no ui block: ${cellId}`);
    }
    for (const e of list) e.handler = handler;
    return (): void => {
      for (const e of list) {
        if (e.handler === handler) e.handler = null;
      }
    };
  },

  /**
   * Dispatch a cell by id. Throws if no handler is bound — Phase 2.4
   * registers global hotkey handlers at app boot via `useFeatHotkeys`
   * or a top-level effect, so missing handlers are user errors.
   */
  async dispatch(cellId: string, args?: unknown): Promise<void> {
    const list = entries.get(cellId);
    const handler = list?.[0]?.handler ?? null;
    if (handler === null) {
      throw new Error(`uiRegistry.dispatch: no handler bound for ${cellId}`);
    }
    await handler(args);
  },

  /** True if a handler is currently bound. */
  hasHandler(cellId: string): boolean {
    return (entries.get(cellId)?.[0]?.handler ?? null) !== null;
  },

  /** Return the ui block for `cellId` (manifest or local), or undefined. */
  getUiBlock(cellId: string): import('./types.js').UiCellBlock | undefined {
    return entries.get(cellId)?.[0]?.binding.ui;
  },

  /** Test-only: reload from manifest (clears all bound handlers). */
  __reset(): void {
    entries = buildEntries();
  },
};
