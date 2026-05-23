/**
 * UI affordance metadata for a manifest entry.
 *
 * When a cell carries a `ui` block, the frontend exposes it through the
 * keyboard engine and the `<CmdButton>` component (see CLAUDE.md §10.5
 * and `docs/rfcs/0004-ui-cmd-keyboard-engine.md`).
 *
 * `scope` is intentionally typed as a `string` here so this package
 * stays free of any apps/web import. The frontend narrows it to its
 * `Feat` catalogue (`'global' | Feat | '${Feat}.${string}'`) at the
 * consumption boundary and asserts validity at startup.
 *
 * Cells without a `ui` block remain valid — they are simply invisible
 * to the keyboard engine (still callable via Terminal / AI).
 */

export type CmdGroup = 'nav' | 'view' | 'action' | 'edit';

/**
 * Predicate context handed to `when()`. Kept as an interface here so
 * `packages/shared` does not depend on the frontend Feat catalogue.
 * The frontend installs the concrete `Feat`-typed context at runtime.
 */
export interface UiCmdCtx {
  /** Currently focused Feat (frontend `Feat` value) or null. */
  readonly activeFeat: string | null;
  /** Feat currently rendered fullscreen, or null. */
  readonly fullscreen: string | null;
  /** Sub-focus stack inside the active Feat (deepest last). */
  readonly subFocus: readonly string[];
  /** True while a modal owns focus. */
  readonly modalOpen: boolean;
  /** True while the keyboard hint floating window is open. */
  readonly hintOpen: boolean;
}

export interface UiCellBlock {
  /**
   * Where this cell is reachable from:
   *   - `'global'`       — always active.
   *   - `<Feat>`         — only when that Feat is `activeFeat`.
   *   - `<Feat>.<sub>`   — only when the named sub-focus is at the top
   *                        of the Feat's sub-focus stack (e.g. `MKT.sector`).
   */
  readonly scope: string;
  /**
   * Each entry is a full key sequence in canonical form, space-separated
   * for multi-key sequences. Single uppercase letter means "shift+letter"
   * (e.g. `'D'`). Named keys are `'Esc'`, `'Enter'`, `'Tab'`. Examples:
   * `'g m'`, `'d d'`, `'D'`, `'?'`, `'z f'`.
   *
   * Omitted = mouse-only (still routed through `<CmdButton>` but no key).
   */
  readonly keys?: readonly string[];
  /** Label shown in the floating hint window. */
  readonly label: string;
  /** Bucket the hint window groups under. */
  readonly group: CmdGroup;
  /**
   * Optional predicate gated on UI state. Must be pure — no IO, no
   * stateful reads beyond the supplied `ctx`. Evaluated lazily during
   * key matching.
   */
  readonly when?: (ctx: UiCmdCtx) => boolean;
}
