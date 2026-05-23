# UI Command Set — Per-Feat Rollout Playbook

When you want a Feat to participate in the keyboard / `<CmdButton>` system, follow these steps. The cost is small (a few lines per cell) and the win is uniform — mouse, keyboard, Terminal, and AI all dispatch through the same path.

## Prerequisites

- Read [CLAUDE.md §10.5](../../CLAUDE.md) for the contract.
- Skim the canonical example: `apps/web/components/feat-sec-list/feat-sec-list.tsx` (Phase 3.1 + 3.4) — sector chip Delete (`D`) + Publish toggle (`P`).
- Confirm the action is a cell, not view-local state. Boundary rule: if the same action exists as a Terminal command or AI tool, it must be a cell. View-only operations (form open, tab switching, scroll, zoom) stay in component state.

## Step 1 — Add a `ui` block to the manifest entry

In [packages/shared/src/instructions/manifest.ts](../../packages/shared/src/instructions/manifest.ts), find the cell and add:

```ts
ui: {
  scope: 'WATCH.LIVE',        // 'global' | Feat | `${Feat}.${sub}`
  keys: ['D'],                // Vim style: 'D', 'P', 'g m', 'd d'. Use Shift+letter for destructive.
  label: 'Delete focused task',
  group: 'action',            // 'nav' | 'view' | 'action' | 'edit'
}
```

The block is optional — cells without it stay terminal/AI-only.

### Key convention

- Lowercase letters / sequences for navigation + view (`j`, `k`, `g m`, `z f`).
- Uppercase letter (shift+letter) for destructive / costly (`D`, `P`, `R`).
- `?` is reserved for the hint window. `Esc` is reserved for the priority chain (hint → fullscreen → buffer → modal).
- Check `apps/web/lib/ui-cmd/global-cells.ts` for existing global bindings (`g m`, `g e`, `z f`, `z m`, `j`, `k`).

## Step 2 — If the cell needs row context, register a local handler

For operations that act on the currently-focused row (delete THIS task, publish THIS sector), the engine doesn't carry row context. Register a handler that reads from your local store:

```tsx
import { useFeatHotkeys } from '../../lib/ui-cmd/index.js';
import { Feat } from '../../lib/eqty/feat.js';

useFeatHotkeys(Feat.WatchLive, {
  'watch.remove': () => {
    const focused = useWatchStore.getState().focusedTask;
    if (focused === null) return;
    // Reuse the existing useConfirm-guarded flow:
    onDeleteTask(focused);
  },
});
```

The hook auto-unbinds on unmount. Throws in dev if the cellId is unknown or its scope doesn't match the passed Feat.

**Note**: most existing Feats don't yet expose a "focused row" — you may need to add `focusedX` + setter + j/k navigation cells before the destructive hotkey is useful. See `feat-sec-list` for the sector chip pattern: clicking a chip sets both `activeSectorId` AND `useFocusStore.setActive(Feat.Mkt)`.

## Step 3 — For cells with NO row context, you can skip Step 2

When the action is independent of focus (e.g. "open new sector form" at the top of MKT), `<CmdButton>` works without `useFeatHotkeys`. `useCommand` falls back to direct HTTP dispatch via `feCenter`. The auto-confirm gate fires for `doubleConfirm` cells.

```tsx
import { CmdButton } from '../../lib/ui-cmd/index.js';
<CmdButton cmd="watch.remove" args={{ id: task.id }} />
```

`CmdButton`:
- pulls `aria-label` from `ui.label`
- shows `ui.keys[0]` in the `title` tooltip
- is disabled only if neither a local handler NOR a manifest entry exists
- dispatches via `useCommand`, which:
  1. uses the local handler if `useFeatHotkeys` bound one,
  2. else fires the confirm gate (if manifest declares `doubleConfirm`),
  3. else POSTs `/api/instructions/<id>` and fans out `revalidate` scopes on success.

## Step 4 — Mouse path parity rule

Per §10.5, if the same action already has a mouse path elsewhere (e.g. an icon button in a chip), it MUST go through the same cell dispatch. Either:
- Replace the icon button with `<CmdButton cmd="..." args={...}>`, OR
- Keep the icon button but have its `onClick` call `useCommand(cellId)(args)` instead of the service directly.

Direct `onClick={() => service.remove(...)}` for an action that exists as a cell = MAJOR finding under `a11y-reviewer`.

## Step 5 — Test

- Add a unit test that the manifest entry's `ui` block survives schema validation (already covered by `packages/shared/src/instructions/ui.test.ts`).
- If you bound via `useFeatHotkeys`, add a renderHook test for the bind/unbind lifecycle (see `apps/web/lib/ui-cmd/hooks/use-feat-hotkeys.test.tsx`).
- If you replaced a mouse path with `<CmdButton>`, add a RTL click test — confirm dialog appears for `doubleConfirm` cells (see `apps/web/lib/ui-cmd/components/cmd-button.test.tsx`).

## Step 6 — Verify in the hint window

Run `pnpm --filter web dev`, focus the relevant Feat, hit `?`. Your new key should appear under the correct group with the correct label.

## What NOT to do

- **Do not** `window.addEventListener('keydown', ...)` directly in a Feat — register through `useFeatHotkeys` so the engine sees the binding.
- **Do not** create a parallel manifest for "UI-only commands" — extend the existing cell's `ui` block, or use `registerLocalCell()` for true FE-only operations (see `apps/web/lib/ui-cmd/global-cells.ts`).
- **Do not** abstract `<CmdButton>` into a per-cell wrapper component until you have ≥ 3 call sites with identical styling needs (Rule of three).

## Known follow-ups

- **Confirm message specificity**: the centralized `confirmGuard` uses a generic message based on `summary` + `doubleConfirm`. Feats that need context-rich messages (e.g. "delete sector X with 5 members") should keep their per-component `useConfirm` and call it BEFORE `useCommand` (the gate fires only when args.confirm !== true; passing `{ confirm: true }` skips the auto-gate).
- **Batch cells**: bulk operations (delete N tasks, publish N sectors) currently loop the single cell. Add a `*.batch` cell to the manifest if the loop hits N+1 latency.
- **Row focus state per Feat**: most Feats need a `focusedX` slice + j/k navigation before destructive hotkeys are useful. Pattern: see `apps/web/lib/ui-cmd/global-cells.ts` `registerSectorNavCells`.
