/**
 * Terminal ctx + output shapes — what an `InstructionCell`'s handler
 * and renderer see on the FE side. Historically this file also hosted
 * the legacy `CommandRegistry` / `CommandSpec` plumbing; every
 * instruction has since moved to the cross-side `InstructionCenter`,
 * leaving only the ctx / output types here.
 */

import type { StockIndex } from './completion/stock-index.js';
import type { DataActionRunner } from './actions/types.js';
import type { CommitResolution, Event, InteractiveWidgetAny, OutputEntry } from './engine/state.js';

/* ---------- ctx & stores shim ---------- */

export interface UiStoreShim {
  getFocusCode(): string | null;
  setFocusCode(code: string | null): void;
}

/**
 * Cross-cache invalidation scopes. Re-exported from `@quant/shared`
 * so the manifest entries (where each instruction declares its
 * `revalidate` scopes) and the runtime hosts share a single union.
 * The FE shell fans out `ctx.stores.revalidate(scope)` after a
 * successful `feCenter.dispatch(...)`.
 */
export type { RevalidateScope } from '@quant/shared';
import type { RevalidateScope } from '@quant/shared';

export interface CommandStores {
  readonly ui: UiStoreShim;
  /**
   * Optional — host injects a real implementation; when absent (e.g. in
   * unit tests or when a side-effect-free runner is desired) it
   * silently becomes a no-op.
   */
  readonly revalidate?: (scope: RevalidateScope) => void;
}

export interface CommandCtx {
  readonly actions: DataActionRunner;
  readonly stockIndex: StockIndex;
  readonly stores: CommandStores;
  readonly signal: AbortSignal;
  /**
   * Host-provided handle to dispatch engine events from outside the
   * normal cell-handler return path. Used by long-running streaming
   * cells (`/agent`) that own a socket subscription and need to push
   * `streamChunk` / `streamStepLog` / `streamClose` events as frames
   * arrive. Optional because mock runners + unit tests don't have a
   * dispatch loop.
   */
  readonly dispatchEvent?: (event: Event) => void;
}

/* ---------- output shape ---------- */

export type CommandRunOutput =
  | {
      readonly kind: 'text';
      readonly status: OutputEntry['status'];
      readonly tail: { readonly body: string };
    }
  | { readonly kind: 'interactive'; readonly widget: InteractiveWidgetAny }
  /**
   * Bypass the normal `result` event and dispatch one or more engine events
   * directly. Used by the `clear` cell.
   */
  | { readonly kind: 'engine'; readonly events: readonly Event[] };

/** Resolution → CommitResolution helpers re-exported for convenience. */
export type { CommitResolution };
