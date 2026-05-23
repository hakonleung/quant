# RFC 0004 — UI Command Set & Keyboard Engine

**Status**: accepted (Phase 2 of the a11y / keyboard-first initiative — see CLAUDE.md §10).
**Replaces**: ad-hoc `onClick` → service mutation in Feat components.
**Companion**: CLAUDE.md §10.5.

---

## 1. Decision summary

1. The existing `COMMAND_MANIFEST` in [packages/shared/src/instructions/manifest.ts](packages/shared/src/instructions/manifest.ts) is the **single registry**. We extend `CommandManifestEntry` with an optional `ui` block; we do **not** build a parallel registry.
2. Keystrokes use **Vim-style sequences** (`g m`, `d d`, `D`, `?`, `Esc`). No `mod+` chords.
3. A new `apps/web/lib/ui-cmd/` module owns the matcher, focus stack, hooks (`useFeatHotkeys`, `useCommand`), and `<CmdButton>`.
4. Pure UI state (form open, tab switching, scroll, chart zoom) stays in component state — those are **not** cells. The line: if the action is reproducible from the Terminal or via AI, it must be a cell; if it is purely view-local, it stays React state.

## 2. File layout (`apps/web/lib/ui-cmd/`)

```
ui-cmd/
  types.ts                     # core asset (§2.5.1): UiCellBlock, Scope, UiCtx, KeyToken
  pure/
    parse-keys.ts              # core asset: 'g m' → ['g','m']; 'shift+d' → 'D'
    match.ts                   # core asset: pure sequence matcher
    scope.ts                   # core asset: scope predicate
  registry.ts                  # core-ish: reads manifest, indexes cells with ui block (no React, no fetch)
  store/
    focus.ts                   # zustand: activeFeat, fullscreen, subFocus stack
  engine/
    keymap-engine.ts           # binds to window keydown; pulls registry + focus store
    install.tsx                # <UiCmdEngine /> wrapper mounted from providers.tsx
  hooks/
    use-feat-hotkeys.ts        # binds a Feat's handler bag for its scope; unbinds on unmount
    use-command.ts             # returns a dispatch fn for a cell id
    use-active-scope.ts        # selector hook for components / hint window
  components/
    cmd-button.tsx             # <CmdButton cmd="sector.rm" /> — keyboard-equivalent click path
```

**Core-asset compliance (CLAUDE.md §2.5.1)**:
- `types.ts`, `pure/*`, `registry.ts` import **zero** React / zustand / fetch / storage. Pure TS.
- `store/focus.ts` is framework-bound (zustand) but its types live in `types.ts`.
- The mutable handler map (Feat → cellId → fn) lives inside `registry.ts` as a module-local map; updates go through `registry.bind(...)` / `registry.unbind(...)`. No global singleton drift — tests can construct a fresh registry.

## 3. Public interfaces (exact signatures)

```ts
// types.ts
export type Scope = 'global' | Feat | `${Feat}.${string}`;
export type CmdGroup = 'nav' | 'view' | 'action' | 'edit';

export interface UiCellBlock {
  readonly scope: Scope;
  /** Each string is a full sequence: 'g m', 'D', '?', 'd d'. */
  readonly keys?: readonly string[];
  readonly label: string;
  readonly group: CmdGroup;
  /** Predicate evaluated lazily on keydown. Pure — no IO. */
  readonly when?: (ctx: UiCtx) => boolean;
}

// Extend CommandManifestEntry (in packages/shared):
// readonly ui?: UiCellBlock;

// NOTE (landed): the FE-side `UiCtx` is an alias of the shared
// `UiCmdCtx` in `@quant/shared` — `activeFeat` and `fullscreen` are
// typed `string | null` (not narrowed to `Feat | null`) because the
// `UiCellBlock.when(ctx)` predicate signature lives in shared and
// cannot import the FE's `Feat` enum. Mutators on `useFocusStore`
// still accept `Feat | null` for ergonomics; the store widens on read.
export interface UiCtx {
  readonly activeFeat: string | null;
  readonly fullscreen: string | null;
  readonly subFocus: readonly string[];
  /** True if a modal is open. */
  readonly modalOpen: boolean;
  /** True while the keyboard hint floating window is open. */
  readonly hintOpen: boolean;
}

export type KeyToken = string;             // normalized: 'a', 'A' (shift+a), 'Esc', 'Enter', '?'
export type KeySequence = readonly KeyToken[];

// pure/match.ts
export type MatchResult =
  | { kind: 'exact'; cellId: string }
  | { kind: 'partial' }
  | { kind: 'none' };
export function matchSequence(
  seq: KeySequence,
  bindings: readonly UiBinding[],
  ctx: UiCtx,
): MatchResult;

// registry.ts
export interface UiBinding {
  readonly cellId: string;
  readonly seq: KeySequence;
  readonly ui: UiCellBlock;
}
export const uiRegistry: {
  /** All bindings whose scope is `'global'` or matches `ctx.activeFeat` (or its sub-scopes). */
  visible(ctx: UiCtx): readonly UiBinding[];
  /** Register a runtime handler for a cell. Returns an unbind fn. */
  bind(cellId: string, handler: (args?: unknown) => Promise<void> | void): () => void;
  /** Dispatch a cell by id. Throws if no handler is bound. */
  dispatch(cellId: string, args?: unknown): Promise<void>;
};

// store/focus.ts
export interface FocusState {
  activeFeat: Feat | null;
  fullscreen: Feat | null;
  subFocus: readonly string[];
  modalOpen: boolean;
}
export const useFocusStore: UseBoundStore<StoreApi<FocusState & FocusActions>>;
export interface FocusActions {
  setActive(f: Feat | null): void;
  toggleFullscreen(f: Feat): void;
  pushSubFocus(tag: string): void;
  popSubFocus(): void;
  setModalOpen(open: boolean): void;
}

// hooks/use-feat-hotkeys.ts
export function useFeatHotkeys(
  feat: Feat,
  handlers: Readonly<Record<string, (args?: unknown) => void | Promise<void>>>,
): void;

// hooks/use-command.ts
export function useCommand(cellId: string): (args?: unknown) => Promise<void>;

// components/cmd-button.tsx
export interface CmdButtonProps {
  cmd: string;
  args?: unknown;
  /** Defaults to the cell's `ui.label`. */
  children?: ReactNode;
  className?: string;
  /** When true, render as <a> with role="button" — for use inside menus. */
  asMenuItem?: boolean;
}
```

## 4. Sequence matcher state machine

```
        ┌───────────────────────────────┐
        ▼                               │
     ┌────┐  printable    ┌─────────┐   │
     │Idle│ ────────────► │ Pending │ ──┘ (exact match → fire → Idle)
     └────┘               └─────────┘
       ▲                       │
       │                       │ timeout 1200ms
       │                       │ Esc
       │                       │ no-match
       └───────────────────────┘
```

- `keydown` → normalize: ignore pure-modifier keys; `Shift+letter` → uppercase letter; named keys preserved (`Esc`, `Enter`, `Tab`).
- **Skip rule**: if `document.activeElement` is editable (`<input>`, `<textarea>`, `[contenteditable]`) AND no ancestor has `data-allow-hotkeys="true"`, engine no-ops (the user is typing).
- **`?` special**: always fires the global `ui.hint-toggle` cell regardless of buffer state.
- **`Esc` special** (landed priority chain): if `hintOpen` → close hint, else if `fullscreen` set → exit fullscreen, else if buffer non-empty → clear buffer, else if modal open → close modal.
- **Modal scope**: when `modalOpen`, only bindings whose `when` evaluates true (typically `(ctx) => ctx.modalOpen`) participate.

## 5. Focus lifecycle

| Event | Effect |
|---|---|
| User triggers `g m` | `setActive('MKT')`; engine re-derives `visible(ctx)` lazily on next keystroke. |
| Feat mounts | `useFeatHotkeys(feat, handlers)` binds handlers; does NOT auto-focus the Feat. |
| Feat unmounts | Cleanup unbinds; if it was active, `activeFeat → null`. |
| Fullscreen toggle | `toggleFullscreen(feat)` — does not change scope (kbd stays on same Feat). |
| Minimize | Sets `featViewMode='minimized'` via existing `FeatView` store. Active scope unchanged — user can re-expand with the same shortcut. |
| Modal open | `setModalOpen(true)`; engine restricts to `${activeFeat}.modal` scope until closed. |

`FeatView` already owns `featViewMode` persistence. We do not duplicate that — view-mode cells dispatch through the same Feat's existing store action.

## 6. Wiring

- `apps/web/lib/providers.tsx` mounts `<UiCmdEngine />` once at app root (client-only — guarded by `useEffect`).
- Engine attaches `keydown` to `window` with `{ capture: true, passive: false }`. Captures during pending sequence; releases otherwise.
- Engine reads `useFocusStore.getState()` synchronously inside the handler — no per-keystroke React re-render.
- SSR: no-op until first `useEffect` runs.

## 7. Conflict handling

| Case | Resolution |
|---|---|
| Two cells share `keys` under same scope | Build-time test in `registry.test.ts` asserts no collisions. CI red. |
| Two cells share keys under `global` + `MKT` | MKT wins when MKT is active. (Sub-scope shadows parent.) |
| Cell with no `ui` block | Invisible to engine, still callable via Terminal / AI. |
| `?` typed inside an input | Skipped by the editable-target rule. Use `data-allow-hotkeys` to opt-in. |

## 8. UI vs cell — the boundary rule

| Kind | Cell? | Example |
|---|---|---|
| Action with persisted side effect | **Yes** | delete sector, add ledger entry, toggle watch group |
| Navigation between Feats | **Yes** (global cells) | `g m`, `g e` |
| View-mode toggle (fullscreen/minimize) | **Yes** (FE-only cell) | `z f` |
| Open a modal / form | Yes-but-thin | `ledger.add.open` — opens form; submission triggers `ledger.add` |
| Scrolling, tab switching, chart zoom, hover popovers | **No** | pure React state |
| Form field changes | **No** | controlled inputs |

When in doubt: if the same action exists as a Terminal command or an AI tool, the mouse path must dispatch the same cell.

## 9. Confirmed decisions

1. **Leader timeout**: 1200ms.
2. **Editable-target rule**: engine no-ops when `document.activeElement` is `<input>` / `<textarea>` / `[contenteditable]`. Opt-in via ancestor `data-allow-hotkeys="true"`.
3. **View-mode keys**: `z f` toggles fullscreen, `z m` toggles minimize, `Esc` exits fullscreen first if active.
4. **Confirm-gate**: a global `ConfirmHub` mounts in `providers.tsx`. `useCommand`'s BE-fallback path auto-fires `confirmGuard()` when `manifest.doubleConfirm` is set and the caller did not pass `confirm: true`. Existing `useConfirm()` hooks stay for context-rich confirms; both paths now have proper ARIA + autoFocus + focus-restore (a11y reviewer signed off Phase 3.19).
5. **A11y red flags from the survey**: fixed in Phase 2.7, before Phase 3 begins. Two more reviews ran during Phase 3 (3.15 + 3.19); the last verdict is APPROVE.
6. **`<CmdButton>` for backend cells**: `useCommand` falls through to `feCenter.invokeInstruction` when no local handler is bound; revalidate scopes fire automatically. `CmdButton.disabled` reflects the union (no local handler AND no manifest entry).
7. **Registration order**: `installGlobalCells()` is a module-level side effect — child component `useEffect`s would otherwise race the provider's `useEffect`. Idempotent via the `installed` flag.

## 10. Implemented in Phase 3 (per the rollout playbook)

See [docs/modules/ui-cmd-rollout.md](../modules/ui-cmd-rollout.md) for the per-Feat onboarding recipe and [docs/modules/ui-cmd-status.md](../modules/ui-cmd-status.md) for the live keymap.

- MKT scope: `j`/`k` sector nav, `J`/`K` stock nav, `D` delete sector, `P` toggle publish, `X` remove stock from sector, `N` new sector.
- USR scope: `i` runs `ledger.analyze`.
- AI.EQ / AI.SEC: `R` runs `analyze` / `analyze.sector` against the focused stock / active sector.
- SectorChip mouse icon-buttons now route through `useCommand` to satisfy §10.5 mouse-parity.
- `ScopeBadge` shows the active Feat persistently so users know which keymap is live.
- `ConfirmHub` provides global auto-confirm + Esc cancel + focus restore.

## 11. Still out of scope

- `feat-watch-live` row-delete migration — requires backend route consolidation (`/api/watch/{market}/{code}` → `watch.remove` cell).
- `feat-ledger` `A` (open add form) — needs sub-focus tracking inside `Feat.UsrMain` so the hotkey only fires when the ledger tab is active.
- `focus` cell stock picker as a standalone widget (currently terminal-only).
- Batch cells (`watch.remove.batch`, `ledger.export`) — present mouse paths loop the single cell.

## 12. Test plan

| File | Coverage |
|---|---|
| `pure/parse-keys.test.ts` | normalization (Shift, named keys, sequences) |
| `pure/match.test.ts` | exact / partial / none under scope + when predicate |
| `registry.test.ts` | no key collisions in `COMMAND_MANIFEST`; bind/unbind/dispatch |
| `engine/keymap-engine.test.ts` (jsdom) | sequence dispatch, timeout, Esc cancel, editable skip |
| `hooks/use-feat-hotkeys.test.tsx` | mount/unmount binding lifecycle |
| `components/cmd-button.test.tsx` | renders cell label; dispatches on click + Enter/Space |
