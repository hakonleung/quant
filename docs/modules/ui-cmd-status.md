# UI Command Set — Live Keymap Snapshot

> Snapshot of what's wired as of the end of Phase 3.20. Update when a Feat lands a new `ui` block or a new local cell.
>
> Companion docs: [RFC 0004](../rfcs/0004-ui-cmd-keyboard-engine.md), [rollout playbook](./ui-cmd-rollout.md), [CLAUDE.md §10](../../CLAUDE.md).

## Keymap by scope

### global (always active)

| Keys | Cell | Action |
|---|---|---|
| `g m` | `ui.go-mkt` | Switch to MKT |
| `g e` | `ui.go-eq` | Switch to equity chart |
| `g a` | `ui.go-ai-eq` | Switch to AI (stock) |
| `g s` | `ui.go-ai-sec` | Switch to AI (sector) |
| `g u` | `ui.go-usr` | Switch to user |
| `g t` | `ui.go-term-main` | Switch to terminal |
| `g y` | `ui.go-sys` | Switch to system |
| `z f` | `ui.toggle-fullscreen` | Toggle fullscreen on the active Feat |
| `z m` | `ui.toggle-minimize` | Toggle minimize on the active Feat |
| `?` | `ui.hint-toggle` | Open / close the keyboard hint window |
| `Esc` | — | Priority chain: close hint → exit fullscreen → clear buffer → close modal |

### `MKT` (sector + stock workbench)

| Keys | Cell | Action |
|---|---|---|
| `j` | `ui.sector-next` | Next sector |
| `k` | `ui.sector-prev` | Previous sector |
| `J` | `ui.stock-next` | Next stock in the active sector |
| `K` | `ui.stock-prev` | Previous stock in the active sector |
| `D` | `sector.rm` | Delete the active sector (destructive confirm) |
| `P` | `sector.publish` | Toggle publish on the active sector (destructive confirm) |
| `X` | `ui.sector-remove-stock` | Remove the focused stock from the active sector (confirm) |
| `N` | `ui.sector-new-open` | Open the new-sector dialog |

### `USR`

| Keys | Cell | Action |
|---|---|---|
| `i` | `ledger.analyze` | Run LLM ledger analysis (paid confirm) |

### `AI.EQ`

| Keys | Cell | Action |
|---|---|---|
| `R` | `analyze` | Single-stock sentiment analysis (paid confirm, uses focusCode) |

### `AI.SEC`

| Keys | Cell | Action |
|---|---|---|
| `R` | `analyze.sector` | Sector-aggregate sentiment analysis (paid confirm, uses activeSectorId) |

### `SYS`

| Keys | Cell | Action |
|---|---|---|
| `R` | `update` | Run the unified daily scan (destructive confirm, revalidates everything) |

### `USR.ledger` (sub-scope; active when USR is focused AND the ledger tab is on top)

| Keys | Cell | Action |
|---|---|---|
| `A` | `ui.ledger-add-open` | Open the new-ledger-entry form |

## Manifest cells with a `ui` block

These cells are reachable via Terminal **and** keyboard / `<CmdButton>` because they carry a `ui` block in `packages/shared/src/instructions/manifest.ts`:

- `sector.rm` (MKT)
- `sector.publish` (MKT)
- `ledger.analyze` (USR)
- `analyze` (AI.EQ)
- `analyze.sector` (AI.SEC)
- `update` (SYS)

The other ~28 manifest cells remain Terminal/AI-only — they have no `ui` block. Add one per the [rollout playbook](./ui-cmd-rollout.md) to extend keyboard reach.

## FE-only cells (registered via `registerLocalCell`)

These live in `apps/web/lib/ui-cmd/global-cells.ts`. They never hit the backend; the hint window picks them up via the registry but the cross-process manifest doesn't see them.

- `ui.go-{mkt,eq,ai-eq,ai-sec,usr,term-main,sys}` — module navigation (Phase 2.4)
- `ui.toggle-fullscreen`, `ui.toggle-minimize` — view-mode (Phase 2.4)
- `ui.hint-toggle`, `ui.exit-fullscreen`, `ui.close-modal` — engine specials (Phase 2.4)
- `ui.sector-next`, `ui.sector-prev` — sector nav under MKT (Phase 3.5)
- `ui.stock-next`, `ui.stock-prev` — stock nav under MKT (Phase 3.10)
- `ui.sector-remove-stock` — remove from sector under MKT (Phase 3.10)
- `ui.sector-new-open` — open new-sector dialog under MKT (Phase 3.12, handler bound by `FeatMkt`)
- `ui.ledger-add-open` — open ledger add-entry form under USR.ledger sub-scope (Phase 3.21, handler bound by `FeatLedger`)

## Coverage gaps (known follow-ups)

- **`feat-watch-live`** — row delete uses `/api/watch/{market}/{code}` (custom REST), not `watch.remove` cell. Backend route consolidation needed before refactor.
- ~~**`feat-ledger`** — `A` to open add form needs sub-focus tracking~~ Done in Phase 3.21 via `USR.ledger` sub-scope.
- **`feat-watch-live`** sub-scope (`USR.watch`) — extend the same pattern: focused-group concept + `T` toggle group enabled / `D` delete group.
- **`feat-eq-chart`** — range picker / indicator toggles are pure view-state with no Terminal counterpart, so they fall outside §10.5's "must be a cell" rule. Optional to extend.
- **`focus` cell as a UI widget** — currently Terminal-only. A standalone keyboard-driven stock picker (`/` or `g s` global) needs its own widget design.
- **Batch cells** — `watch.remove.batch`, `ledger.export` etc. would replace today's hand-rolled bulk handlers.

## Engine internals (where to look)

| Concern | File |
|---|---|
| Manifest extension (`UiCellBlock`) | [packages/shared/src/instructions/ui.ts](../../packages/shared/src/instructions/ui.ts) |
| Pure key parsing + matcher | [apps/web/lib/ui-cmd/pure/](../../apps/web/lib/ui-cmd/pure/) |
| Registry + local cells | [apps/web/lib/ui-cmd/registry.ts](../../apps/web/lib/ui-cmd/registry.ts), [global-cells.ts](../../apps/web/lib/ui-cmd/global-cells.ts) |
| Focus store | [apps/web/lib/ui-cmd/store/focus.ts](../../apps/web/lib/ui-cmd/store/focus.ts) |
| Keymap engine + DOM wiring | [apps/web/lib/ui-cmd/engine/](../../apps/web/lib/ui-cmd/engine/) |
| Hooks | [apps/web/lib/ui-cmd/hooks/](../../apps/web/lib/ui-cmd/hooks/) |
| `<CmdButton>` | [apps/web/lib/ui-cmd/components/cmd-button.tsx](../../apps/web/lib/ui-cmd/components/cmd-button.tsx) |
| `<ConfirmHub>` | [apps/web/lib/ui-cmd/confirm/](../../apps/web/lib/ui-cmd/confirm/) |
| `<FeatHotkeyHint>` + `<ScopeBadge>` | [apps/web/components/feat-hotkey-hint/](../../apps/web/components/feat-hotkey-hint/) |
| Mount point | [apps/web/lib/providers.tsx](../../apps/web/lib/providers.tsx) |

## Acceptance status

- **a11y**: `a11y-reviewer` APPROVE (last pass Phase 3.19). Three reviews ran across the build; all REQUEST_CHANGES verdicts were resolved.
- **Tests**: 353 / 353 across `apps/web` and `packages/shared`. ui-cmd-specific: 78.
- **Type check**: `pnpm --filter web exec tsc --noEmit` clean.

If a future change breaks any of the above, the change is incomplete per CLAUDE.md §0.
