# Module 10 — Terminal (`@quant/terminal`)

> Keyboard-driven command terminal core. Standalone library — independent
> of React, Next.js, or xterm.js — with a quant-specific command surface
> bundled on top.

This document is the **single source of truth** for the package surface,
layering, and testing rules. Cross-references: `apps/web/components/feat-term-main/`
(Next.js host wiring), `CLAUDE.md` §2.5.1 (core-asset purity).

---

## 1. Goals & non-goals

**Goals**

- Single keyboard input surface that can drive every read/write workbench
  operation: stock lookup, sector CRUD, analyze, watch, screen.
- Reusable across hosts — Next.js today; Electron / VS Code later — by
  keeping the library free of React, DOM, and xterm-specific code.
- Every instruction lives in the cross-side `InstructionCenter`
  (`packages/shared/src/instructions/`); `@quant/terminal` provides the
  pure engine / widget / render / completion / action primitives only.
- Mock backend in the box. The UX is fully exercisable without any
  Python service running.
- Cyber/geek aesthetic — Monaspace Neon font + the project's `term.*`
  palette baked into the xterm bridge.

**Non-goals (v1)**

- No PTY / shell emulation — only a single-process command dispatcher.
- No pipe (`|`) / chaining (`&&`).
- No remote-persisted command history.

---

## 2. Layering

```
packages/terminal/
  src/
    render/        ANSI / width / table / sparkline               (pure)
    engine/        state · reducer · keymap · argv                (pure)
    widgets/       selectable-list · form · confirm · paste · loop · hint-bar (pure)
    completion/    stock-index · completer (Tab)                  (pure)
    actions/       config registry + Mock runner (LRU cache)      (pure module)
    registry.ts    CommandCtx / CommandRunOutput / UiStoreShim /
                   CommandStores / CommitResolution types          (pure)
    index.ts       public barrel
```

The `commands/` directory and `engine/dispatcher.ts` (`runCommand` function) have been
removed. All instruction logic now lives in
`apps/web/lib/instructions/` (FE cells) and
`apps/api/src/modules/instruction-center/` (BE cells), unified under
`InstructionCenter<E, X>` from `packages/shared/src/instructions/`.

Hard rule (CLAUDE.md §2.5.1): **every file under `src/` is pure** — no
network, no `Date.now()` / `Math.random()` outside seed-injection helpers,
no React, no DOM. The only file that touches a real DOM is the host's
xterm bridge — and that lives in `apps/web/components/feat-term-main/`,
NOT in this package.

### Dependency direction

```
widgets/   →  render/         (table/ANSI/hint-bar)
engine/    →  (none)          (closes over only state.ts types)
actions/   →  zod, @quant/shared
```

Disallowed: `engine/` importing `widgets/`, `widgets/` importing `actions/`.

---

## 3. Public surface

```ts
import {
  // engine
  reduce,
  initialState,
  type TerminalState,
  type Event,
  type Effect,
  type InteractiveWidget,
  type CommitResolution,
  // widgets
  selectableList,
  formPrompt,
  confirmPrompt,
  pasteText,
  pickStockLoop,
  interactive,
  textOk,
  textErr,
  textCached,
  widgetResolution,
  outputResolution,
  // render
  ANSI,
  paint,
  stripAnsi,
  renderTable,
  sparkline,
  // completion
  buildStockIndex,
  complete,
  EMPTY_STOCK_INDEX,
  type StockIndex,
  // actions
  getRunner,
  MockActionRunner,
  ALL_ACTIONS,
  findAction,
  type DataActionConfig,
  type DataActionRunner,
  // registry (ctx / output types only — no CommandSpec / CommandRegistry)
  type CommandCtx,
  type CommandRunOutput,
  type CommandStores,
  type UiStoreShim,
  type RevalidateScope,
} from '@quant/terminal';
```

指令注册与分发由 `InstructionCenter` 承担（详见 `docs/modules/15-instructions.md`），terminal 包不再自持注册表。

### Sub-paths

For tree-shaking and explicit boundary checks:

```ts
import { reduce } from '@quant/terminal/engine';
import { selectableList } from '@quant/terminal/widgets';
import { renderTable } from '@quant/terminal/render';
```

---

## 4. State machine

```
Phase = 'idle' | 'running' | 'cancelling' | 'interactive'

idle      --SubmitEvent-->        running
running   --ResultEvent {text}--> idle
running   --ResultEvent {iact}--> interactive
running   --CancelEvent-->        cancelling
cancelling --(promise settle)-->  idle
interactive --InteractiveKey-->   interactive
interactive --(submit→command)--> idle  (then re-enters running)
interactive --(Esc/CtrlC)-->      idle  (frozen snapshot kept)
```

The reducer is **pure**: it returns `{ state, effects: Effect[] }`. The
host (apps/web `use-terminal.ts`) consumes the effects:

- `runCommand`: routed through `feDispatch(line, ctx)` in
  `apps/web/lib/instructions/dispatch.ts`, which delegates to
  `feCenter.dispatch(...)` on the FE `InstructionCenter`. There is no
  `runCommand` function exported from `@quant/terminal` anymore.
- `commitWidget`: chain widgets, dispatch a follow-up `submit`, or write
  an `output` entry directly.
- `abort`: signal the active AbortController for the current Promise.
- `completionRequested`: the host calls `complete()` with an env built by
  `buildCompleterEnv(stockIndex)` from
  `apps/web/lib/instructions/completion.ts` and either patches the buffer
  (`setBuffer`) or shows candidates (`setCandidates`).

---

## 5. Commands & interactive sub-flows

All commands are FE cells in `apps/web/lib/instructions/cells/` dispatched
via `feCenter` / `feDispatch`. The table below documents the _terminal syntax_
(what a user types); the full arg/result schemas live in
`packages/shared/src/instructions/manifest.ts`.

| Command                       | Form                   | Interactive                                                                                                          |
| ----------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `help [cmd]`                  | text                   | —                                                                                                                    |
| `clear` / `cls`               | text                   | —                                                                                                                    |
| `cache stats / clear`         | text                   | —                                                                                                                    |
| `stock <q>`                   | interactive            | SelectableList → `stock.info <code>`                                                                                 |
| `stock.info <code>`           | text                   | —                                                                                                                    |
| `stock.kline <code>`          | text                   | —                                                                                                                    |
| `sector`                      | interactive            | SelectableList; `a` → analyze (paid+confirm), `d` → remove (owner+confirm), `p` → publish/unpublish (owner+confirm) |
| `sector.show <id>`            | interactive            | members SelectableList; `a` → analyze, `f` → focus                                                                  |
| `sector.add sector=<json>`    | text                   | no guided multi-step form; args passed inline                                                                        |
| `sector.refresh <id>`         | text                   | any user may refresh dynamic sectors (server persists)                                                               |
| `sector.publish <id>`         | text                   | owner-only; toggles `published`                                                                                      |
| `sector.unpublish <id>`       | text                   | owner-only                                                                                                           |
| `sector.rm <id>`              | text                   | owner-only                                                                                                           |
| `analyze [code=<c>] [fresh=1]`| text or confirm        | `confirm-required` envelope triggers confirm widget for paid / fresh paths                                           |
| `analyze.sector <id> [fresh]` | text or confirm        | confirm for paid path                                                                                                |
| `ta [code=<c>] [fresh=1]`     | text or confirm        | technical analysis; `confirm-required` for fresh LLM paths                                                           |
| `ta.sector <id> [fresh=1]`    | text or confirm        | per-stock TA fan-out + LLM sector narrative                                                                          |
| `screen <text> [asof=DATE]`   | confirm → results list | save matches as dynamic sector (`nl` keyword dropped)                                                                |
| `watch`                       | interactive            | SelectableList; `d` → remove (confirm)                                                                               |
| `watch.add code=... [...]`    | text                   | no guided form; `watch.group` for group management                                                                   |
| `watch.remove id=wN`          | text                   | —                                                                                                                    |
| `focus [<code>]`              | text or picker         | —                                                                                                                    |
| `ledger [sub=list] [limit=N]` | text                   | —                                                                                                                    |
| `ledger.add` / `ledger.remove`| text                   | —                                                                                                                    |
| `ledger.analyze [fresh=1]`    | text or confirm        | LLM portfolio narrative; async channel                                                                               |
| `agent <prompt>`              | streaming text         | confirm card for paid/destructive tool calls                                                                         |
| `agent.confirm correlationId` | text                   | resumes a paused agent loop                                                                                          |
| `usr`                         | text                   | user identity + LLM ledger summary                                                                                   |
| `update target=blacklist`     | text                   | —                                                                                                                    |

### Cross-cutting rules

- **Paid operations** surface a `confirm-required` envelope; the renderer
  produces a `confirmPrompt(danger=true)` widget. Affected: `analyze`,
  `analyze.sector`, `ta`, `ta.sector`, `screen`, `ledger.analyze`, `agent`.
- **Destructive operations** (rm, watch.remove, cache clear) always confirm.
- Esc / Ctrl-C inside any widget cancels the chain and writes a frozen
  `info` snapshot to history; further keys go back to the prompt.
- Every widget MUST declare its hints via `hints(state) → KeyHint[]`. The
  bridge unconditionally renders the hint bar — but the widget's own
  `render()` already includes it, and the bridge does not double up.

---

## 6. Action abstraction (mock vs live)

The terminal never imports `endpoints.ts` or zustand stores directly.
Every data access goes through the action registry:

```ts
interface DataActionConfig<A, R> {
  id: string;
  kind: 'read' | 'write' | 'paid';
  args: ZodTypeAny; // schema-validates input at the boundary
  result: ZodTypeAny; // schema-validates output (server bug guard)
  cacheKey?: (a) => readonly (string | number | boolean)[];
  invalidates?: (a) => readonly (readonly KeyParts)[][];
}

interface DataActionRunner {
  id: 'mock' | 'live';
  run(cfg, args, opts): Promise<{ data: R; cached: boolean }>;
  invalidate(prefix): void;
  stats(): { entries; hits; misses };
}
```

15 actions ship in v1: `stock.list / .info / .kline / .snapshots`,
`sector.list / .show / .upsert / .remove / .refreshDynamic`, `analyze.one
/ .many`, `screen.nl`, `watch.list / .upsert / .remove`.

**MockActionRunner** reads in-memory fixtures (200 sample stocks + working
sector / watch state), persists reads to a TTL+LRU cache backed by
`localStorage` (`tm.cache.<hash>`), and resolves write/paid actions
synchronously. Latency can be simulated via the constructor's
`latencyRange` option.

**LiveActionRunner** ships in `apps/web/lib/term/live-runner.ts` (commit
3fff934). It calls real `/api/*` endpoints per action id, then runs a
`REVALIDATE_AFTER` table that maps action ids → react-query queryKey
prefixes + zustand store fetches. Today the table covers
`analyze.{one,many}` (sentiment), `sector.{upsert,remove,refreshDynamic}`
(sectors), and `watch.{upsert,remove}` (no-op; SSE re-pushes within ~1s).

Switch via `localStorage.setItem('tm.runner', 'mock')` for fixtures;
remove the key (or set anything else) to use live (default).

---

## 7. Tab completion

`completer.complete(buffer, cursor, env)` is pure: it returns
`{ commonPrefix, candidates, tokenStart, tokenEnd }`. The host:

1. Reduces `key: Tab` → effect `completionRequested`.
2. Calls `complete(...)` with `env` built by
   `buildCompleterEnv(stockIndex)` from
   `apps/web/lib/instructions/completion.ts`.
3. If exactly one candidate → `setBuffer` patches the active token.
4. Otherwise inserts the longest common prefix; if user already typed
   the LCP, surfaces candidates via `setCandidates`.

`buildCompleterEnv` derives the `commands` + `subcommands` lists directly
from `INSTRUCTION_MANIFEST` (the cross-side source of truth). There is no
longer a `CommandSpec.complete` hook — per-positional parameter completion
is wired inside the completer env via the `STOCK_CODE_IDS` set (ids whose
first positional is a 6-digit A-share code). Stock candidates route through
`StockIndex.complete(prefix)`, a code/name/pinyin three-way prefix index
built once at terminal mount.

---

## 8. Theming & font

- Cyber palette: imported from `apps/web/lib/theme/tokens.ts:term.*`.
  The bridge maps it onto xterm's ANSI color slots so `paint(text, ANSI.green)`
  always renders neon-green, not xterm's washed-out default.
- Font: `'Monaspace Neon'` first; falls back through Krypton → Argon →
  JetBrains Mono → SF Mono → ui-monospace. Loaded via
  `@fontsource/monaspace-neon` over jsDelivr in `apps/web/app/layout.tsx`.

---

## 9. Keyboard shortcuts

Beyond the standard prompt-line editing, the package recognizes:

| Key                                  | Action                         |
| ------------------------------------ | ------------------------------ |
| `Ctrl+A` / `Cmd+Left`                | jump to line start             |
| `Ctrl+E` / `Cmd+Right`               | jump to line end               |
| `Ctrl+U` / `Cmd+Backspace`           | delete to line start           |
| `Ctrl+K`                             | delete to line end             |
| `Ctrl+W` / `Alt+Backspace` / `Opt+⌫` | delete previous word           |
| `Alt+B` / `Ctrl+Left` / `Opt+←`      | jump one word to the left      |
| `Alt+F` / `Ctrl+Right` / `Opt+→`     | jump one word to the right     |
| `Ctrl+L`                             | clear scrollback               |
| `Tab`                                | command / parameter completion |
| `Up` / `Down` (idle)                 | command history recall         |
| `Esc` / `Ctrl+C`                     | cancel current widget chain    |

Browser-swallowed shortcuts (Cmd/Alt+Arrow on macOS) are caught via
xterm's `attachCustomKeyEventHandler` and translated by
`engine/keymap.ts:fromBrowserEvent`.

---

## 10. Hosting (apps/web)

The Next.js host owns three small files, all under
`apps/web/components/feat-term-main/`:

- `feat-term-main.tsx`: registers `Feat.Terminal = 'TERM.MAIN'`, mounts a
  `FeatView` shell, attaches the host `<div>` via a ref-callback (handles
  the FeatView fullscreen subtree remount).
- `use-terminal.ts`: bridges xterm.js to the engine — `onData` →
  `toKeySpec` → `dispatch`; `runCommand` effects → `feDispatch`;
  renders state to the xterm scrollback incrementally (footer-only erase,
  no full clear).
- (no other code).

The `CommandCtx` type (from `registry.ts`) is the contract between the
package and the host. The host injects:

- `ctx.stores.ui` — a `UiStoreShim` wrapping `useUiStore`
  (`getFocusCode` / `setFocusCode`).
- `ctx.stores.revalidate` — optional callback; the FE shell fans out
  manifest-declared `RevalidateScope` values after a successful dispatch.
- `ctx.dispatchEvent` — optional handle for streaming cells (`/agent`)
  that push `streamChunk` / `streamClose` events outside the normal
  handler return path.

The package never imports zustand or the workbench's store modules. The
`runCommand` effect from the engine is handled by `feDispatch` in the host
(`use-terminal.ts`); there is no dispatcher inside `@quant/terminal`.

---

## 11. Tests

Unit tests in `packages/terminal/src/**/*.test.ts` (no `commands/` tests
— those moved to `apps/web/lib/instructions/` cell tests):

- `render/`: ANSI strip, CJK width, table alignment, sparkline.
- `engine/`: reducer (idle / running / cancelling / interactive +
  word/line nav), keymap, parse-argv, prevWordBoundary / nextWordBoundary.
- `widgets/`: each widget's state→state, state→commit, render output,
  CJK rendering, danger-default selection (confirm), search-field flow
  (form), basket dedup (pick-stock-loop).
- `completion/`: stock-index ranking (code > name > pinyin) + completer.
- `actions/`: mock-cache TTL/invalidate, registry uniqueness, mock-runner
  end-to-end with abort + invalidate semantics.

Run:

```
pnpm --filter @quant/terminal test
pnpm --filter @quant/terminal test:cov   # 90% lines / 80% branches gate
```

---

## 12. Roadmap

当前状态：

- mock 与 live 双 runner，`tm.runner` 切换；
- 所有指令以 FE cell（`apps/web/lib/instructions/cells/`）形式落地，Tab 补全由 `INSTRUCTION_MANIFEST` 通过 `buildCompleterEnv` 派生；
- 待办：脚本模式（`pipe`, `&&`）、用户级 keybindings、可选远端 history 同步。
