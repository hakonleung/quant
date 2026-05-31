# Quant Project Engineering Spec (Multi-language)

> This file is the highest-authority instruction for Codex in this repo. All code generation, modification, and review must strictly follow this spec.
> Violating any hard rule counts as task-not-done and must be fixed immediately.

The project uses two stacks: **TypeScript (Next.js frontend + NestJS backend)** and **Python (compute / LangGraph)**. Cross-language communication is via **Apache Arrow Flight (gRPC)**. See `docs/architecture.md` and `docs/integrations/ipc-py-ts.md`.

---

## 0. Workflow (mandatory)

For every coding task, follow this order:

1. **Understand → Design**: read the relevant files and module docs under `docs/`. Make boundaries and dependencies explicit. For non-trivial tasks, draft a plan before coding.
2. **Implement**: write code per "Code style" and "Modularity" rules in this doc. When crossing process boundaries, check/update the contract in `docs/integrations/ipc-py-ts.md`.
3. **Test**: for **new/modified business logic**, invoke `test-generator` to generate tests and run `run-tests`; failures must be fixed to green. Pure scaffolding / config / docs changes are exempt.
4. **Self-review**: invoke `code-reviewer` only if one of: ① user explicitly requested review; ② milestone / feature wrap-up containing non-trivial business logic; ③ cross-process contract (`proto/` / Arrow schema) change. **Do NOT trigger reviewer for pure scaffolding, config tweaks, formatting, or docs.** Otherwise, `pnpm check` is the standing gate.
5. **Delivery**: final report lists changed files and test results; if review ran, include verdict.

If you skip step 3 / 4, state the reason explicitly (e.g. "README-only change, no tests/reviewer needed").

---

## 1. Code style (hard, non-negotiable)

### 1.1 Python general

- **Formatting**: `ruff format` and `ruff check --fix`, line width 100.
- **Type annotations**: every function signature, public attribute, and module-level constant must be fully annotated; `mypy --strict` must pass.
- **Naming**:
  - modules/packages: `snake_case`
  - classes: `PascalCase`
  - functions/variables: `snake_case`
  - constants: `UPPER_SNAKE_CASE`
  - private: single leading underscore `_name`
- **Forbidden**:
  - `from x import *`
  - bare `except:` (must catch specific exceptions)
  - mutable default arguments
  - repeatedly constructing the same invariant object inside a loop
  - `print` for business logging (use `logging`)
  - single-letter names (except `i/j/k` as loop indices, or `x/y` in math formulas)
- **Required**:
  - functions ≤ 50 lines; split if longer
  - single file ≤ 400 lines; split into modules if longer
  - cyclomatic complexity ≤ 10
  - public APIs must have Google-style docstrings (Args / Returns / Raises)
  - I/O, network, disk and other side effects confined to boundary layers (adapters / io / repository)

### 1.2 TypeScript general (shared by Next.js + NestJS)

- **Formatting**: `prettier` (line width 100, single quotes, trailing comma all), `eslint --fix`.
- **tsconfig strict constraints** (violations always rejected):
  ```json
  {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true,
    "strictBindCallApply": true,
    "strictPropertyInitialization": true,
    "noImplicitThis": true,
    "alwaysStrict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noPropertyAccessFromIndexSignature": true
  }
  ```
- **Type-safety hard rules (zero tolerance)**:
  - No `any`, `as any`, `as unknown as T` (double assertion)
  - No `// @ts-ignore`; when necessary use `// @ts-expect-error <reason: one-line cause>`, and it must be periodically scannable in lint for cleanup
  - No bare `as T` cast; narrow types via: ① type-guard function `is T` (with runtime check) ② `zod.parse` ③ `switch` narrowing on a user-defined discriminated union
  - No `Function`, `Object`, `{}` as types; use concrete function signatures or `Record<K, V>`
  - No unconstrained generics: `<T>` must have `extends ...` or appear in multiple positions of the signature to express a relationship
  - No non-null assertion `!`; use type guards or explicit throws
  - Cross-process / external input must be validated via `zod` before entering business code; never "trust" external JSON
  - When third-party types are missing, write `*.d.ts` rather than `as any`
- **Naming**:
  - files/directories: `kebab-case.ts`
  - classes/types/interfaces: `PascalCase` (no `I` prefix on interfaces)
  - variables/functions: `camelCase`
  - constants: `UPPER_SNAKE_CASE`
  - React component files: `PascalCase.tsx`
- **Forbidden**:
  - `console.log` for business logging (use NestJS `Logger` / `pino`)
  - default exports (unless framework-mandated: Next.js pages, layouts, etc.)
  - `enum` (use `as const` objects + literal union types)
  - `require()` (use ESM `import`)
  - `new Date()` / `Math.random()` inside a component body — inject via props/hook
- **Required**:
  - functions ≤ 50 lines; React components ≤ 150 lines (including JSX)
  - single file ≤ 400 lines
  - async function return types explicitly annotated `Promise<T>`
  - cross-process boundary inputs/outputs validated by `zod` schemas; schema and types share the same source (`z.infer`)
  - DTO and domain types separated: `*.dto.ts` (boundary) / `*.entity.ts` or `*.model.ts` (domain)

### 1.2.1 Python type-safety reinforcement

- No `Any` (use `object` or a bounded `TypeVar` when truly needed)
- No bare `# type: ignore`; must be `# type: ignore[error-code]  # reason`
- No `cast(T, x)` when `x` is from external input; go through `pydantic` validation
- Generics must use `TypeVar(... bound=...)` or `Protocol`; no bare `TypeVar("T")`
- `mypy --strict` must pass with zero warnings

### 1.3 Error handling (shared by both languages)

- Internal pure-function calls: trust the contract, no defensive checks.
- System boundaries (user input, external API, files, network, cross-process): must validate explicitly and raise domain exceptions.
- Python base exception `QuantError` (`packages/py/quant_core/errors.py`); TS base exception `QuantError` (`packages/shared/errors.ts`). The exception **type string** must match across sides (`code: "DATA_SOURCE_TIMEOUT"`, etc.); cross-process serialization uses the RPC error-code table (see `docs/integrations/ipc-py-ts.md`).
- Never `except Exception` / `catch (e)` and swallow the error; at minimum log + rethrow or convert to a domain exception.

### 1.4 Logging

- Python: `logging.getLogger(__name__)`; no `print`.
- TS: NestJS `Logger` (backend) / `pino` (server-side frontend); no `console.log`.
- Level semantics: `DEBUG` dev detail / `INFO` business milestone / `WARN` recoverable / `ERROR` business failure / `FATAL/CRITICAL` process-level failure.
- **Structured fields preferred** (Python: `logger.info("trade_filled", extra={...})`; TS: `logger.info({ symbol, qty }, "trade_filled")`); don't build strings.
- Cross-process calls must carry `trace_id`, generated at the entry and propagated downstream.
- **LLM call logs must be structured**: every NestJS `LlmService` call must emit `provider`, `model`, `scope` (agent/screen/analyze/...), `usage` (input/output/total tokens), `durationMs`, `traceId`, `userId`. Failure paths log too (usage may be missing). Companion writes to `UserLlmLedgerStore` are done by the recorder — do not hand-write a second copy at the call site.

### 1.5 Comments

- Default: no comments. Only write one line where the "why" is non-obvious: hidden constraints, workarounds for a specific bug, trade-offs at odds with the docs.
- Forbidden: restating what the code does; ownerless/dateless TODOs; references to the current task / PR / issue.

---

## 2. Modularity and decoupling (hard)

### 2.1 Process topology

```
┌─────────────┐    HTTP/SSE     ┌──────────────┐  Arrow Flight (gRPC)  ┌──────────────┐
│  Next.js    │ ──────────────> │   NestJS     │ ────────────────────> │  Python svc  │
│  (frontend) │ <────────────── │  (backend)   │ <──────────────────── │  (compute +  │
└─────────────┘                 └──────────────┘                       │   LangGraph) │
                                                                       └──────────────┘
```

- **Next.js**: UI, user interaction, SSR rendering, SSE/WS for long-task progress. **Does not call external data sources / LLMs directly.**
- **NestJS**: HTTP API gateway, request validation, short-task orchestration, **all persistence writes** (including `data/kline/*.parquet` / `data/stock_metas.parquet` / `data/sectors/*` / `data/users/**/*` etc.), scheduling Python services, and the **external LLM client** (OpenAI-compatible protocol; DeepSeek / Moonshot / Qwen / Doubao / OpenAI). LLM provider registry and token-ledger persistence live on the NestJS side; upper-layer services call through a unified `LlmService`. v1 has no auth (binds to 127.0.0.1).
- **Python service**: external data fetch (tushare / akshare) for quotes/news, screening / pattern / sentiment compute, LangGraph workflows. **Python is compute-only**: every Flight op returns computed results to NestJS, which writes to disk. Reads from disk are allowed (shared local disk + DuckDB column pruning), since reads do not create cross-process contention; NestJS is the sole writer. **Python does not hold an external LLM client**; if a future LangGraph node needs LLM inference, it makes a reverse RPC to NestJS `LlmService`.

### 2.2 Repo layout (monorepo, pnpm workspaces + uv)

```
apps/
  web/                          # Next.js frontend
  api/                          # NestJS backend
packages/
  shared/                       # TS shared: types, zod schemas, error codes, API client SDK
  ui/                           # Shared React components
services/
  py/                           # Python service root
    quant_core/                 # Domain + business (see §2.3)
    quant_compute/              # Compute-intensive modules (screening / pattern / sentiment)
    quant_io/                   # Data-source adapters
    quant_cache/                # Cache adapters
    quant_workflow/             # LangGraph orchestration (v2; reverse-RPC to NestJS LlmService for LLM inference)
    quant_rpc/                  # Arrow Flight server
proto/                          # Arrow schemas (.fbs) + RPC contracts (shared)
docs/                           # Engineering docs
tests/                          # Mirrors src paths
```

### 2.3 Python internal layering (mandatory)

```
domain/        # Pure domain models and rules (K-line / stock / screen-condition AST / pattern / sentiment topic); no external framework / IO
services/      # Business orchestration; depends only on domain and ports
ports/         # Abstract interfaces (Protocol / ABC)
adapters/      # Concrete implementations of ports: tushare/akshare, Parquet, Redis, LLM
io/            # Read/write boundary: parser/serializer/HTTP client
config/        # Configuration loading (pydantic-settings)
rpc/           # Arrow Flight server entry
workflow/      # LangGraph nodes and graphs
```

**Dependency direction**: `rpc/workflow → services → domain`, `services → ports ← adapters`.
`domain` may not import `adapters/io` or any concrete SDK.

### 2.4 NestJS internal layering (mandatory)

```
modules/
  <feature>/
    <feature>.controller.ts     # Route; only param validation (zod-pipe) + delegate to service
    <feature>.service.ts        # Business orchestration; calls ports
    <feature>.module.ts         # DI wiring
    dto/                        # zod schema + types
    domain/                     # Pure domain types + functions (no decorators, no nest deps)
ports/                          # Abstract interfaces (pure TS)
adapters/                       # Concrete port implementations (incl. Arrow Flight client)
common/                         # Guards, interceptors, filters, logger
config/                         # @nestjs/config + zod validation
```

**Dependency direction**: `controller → service → ports ← adapters`.
The `domain/` subdirectory holds pure functions + immutable types, free of NestJS decorators, for easy reuse and testing.

### 2.5 Next.js constraints

- Routing uses the App Router (`app/`).
- **Server components preferred**; only interaction-leaf components use `"use client"`.
- Data fetching: server components call NestJS directly with `fetch` (with caching strategy); clients use `@tanstack/react-query`.
- Long-task progress: SSE (`EventSource`) or WebSocket, fanned out from NestJS.
- UI state with Zustand (lightweight); forms with `react-hook-form` + zod.
- No business logic inside components — extract to `lib/` pure functions.

#### Feat component rules (mandatory)

- **Feat = pane-level functional unit**, namespaced as `[MODULE].[FEATURE]` (see `apps/web/lib/eqty/feat.ts`).
- Every Feat lives in its own directory under `apps/web/components/` as `feat-<module>-<feature>/` (kebab-case, e.g. `feat-sys-stat/`, `feat-eq-chart/`); the main component file matches the directory name (`feat-sys-stat.tsx`); the exported function is `Feat<Module><Feature>` (e.g. `FeatSysStat`). Feat-private sub-components / dialogs / forms live in the same directory.
- **Every Feat's root must be wrapped in `<FeatView feat={Feat.X}>`** (from `components/feat-view/feat-view.tsx`). `FeatView` uniformly handles pane chrome, `featViewMode` (normal / minimized / fullscreen) persistence, overlay / default-minimized behavior. Feats that render raw DOM directly or roll their own pane shell are rejected.
- `FeatView`, `FeatViewStatus`, `FeatViewAction`, `FeatViewHeaderRight` under `feat-view/` are the only pane primitives allowed to be shared across Feats; Feats must not import each other's private sub-components — promote shared pieces to `packages/ui/` or `apps/web/lib/`.

### 2.5.1 Types and pure functions = core assets (mandatory)

**Type definitions and pure functions are the project's core assets; they must be maintained independently, decoupled from frameworks, and reusable by any module/service at any time.**

Each process must have dedicated directories carrying these two asset classes. These directories:

- Do not depend on any framework (NestJS decorators, Next.js hooks, runtime base classes other than pydantic, etc.)
- Do not do IO (no import of adapters, io, http clients, DB drivers)
- Do not depend on config (no env reads / no global settings)
- May be imported by any other directory; they **may not** import any non-core directory in the same process.

**Python side** (`services/py/quant_core/`):

```
domain/
  types/        # Pure type definitions (@dataclass(frozen=True, slots=True) / TypedDict / Protocol)
  pure/         # Pure functions (no side effects, no IO, deterministic in→out)
  rules/        # Business-rule functions (also pure, but business-semantic, e.g. "compute forward-adjusted price", "detect limit-up")
```

**TypeScript side**:

```
packages/shared/
  types/        # Cross-app shared types (zod schema + z.infer types)
  fp/           # Cross-app shared pure functions (math, dates, strings, immutable containers)
apps/api/src/modules/<feature>/
  domain/
    types.ts    # Feature domain types
    pure.ts     # Feature pure computation functions
apps/web/lib/
  types/        # Frontend-only types (UI state, view models)
  fp/           # Frontend-only pure functions (formatters, selectors)
```

**Hard constraints**:

- `domain/`, `packages/shared/`, `lib/fp/`, `lib/types/` **must not** contain: `fetch`, `axios`, `fs`, `db`, `Logger`, `@Injectable()`, `useEffect`, `useState`, or any import of `*.adapter.ts`.
- Any function that "looks pure but secretly reads global state" (e.g. `Date.now()`, `Math.random()`, `process.env`) must take its dependency as a parameter.
- Tests for these directories are **unit-only**, zero mocks, zero fixtures (other than input data). If you need mocks to test, it isn't pure — move it out.
- code-reviewer must explicitly check "any dependencies that don't belong in a core directory"; violation = MAJOR.

### 2.5.2 Reusability (mandatory principle, but avoid over-abstraction)

- **Reuse beats copy-paste**: the same logic in ≥ 2 places that's likely to recur → extract to a core directory. But **don't** build an abstraction for a single call site.
- **Rule of three**: only abstract on the third repetition; mark the second with `// REUSE-CANDIDATE: <ref>`, then extract all on the third.
- **Cross-language reusable logic must live in `proto/` or be script-generated**: avoid TS and Py each rolling their own reconciliation logic — schemas are generated from `proto/`, pure algorithms (e.g. forward adjustment) have Python as the single implementation, TS calls them via RPC; a hand-written second copy is forbidden.
- **Abstraction costs more than repetition**: when the abstraction needs ≥ 3 parameters to cover the differences, or its body has if-else branches keyed on the caller, the abstraction is wrong — fall back to repetition.
- **No "abstract before use"**: never write a utility that has no caller; the only exception is generated-code placeholders.

### 2.6 Functions and classes (shared)

- **Single responsibility**: a function does one thing; a class has one reason to change.
- **Pure functions preferred**: if it can be a pure function, don't make it a method; if it can be stateless, don't hold state.
- **Dependency injection**: external dependencies (client, session, clock, randomness source) must be passed in via parameters / constructor; do not import global singletons inside function bodies.
- **No god objects**: a class with > 7 public methods or > 200 lines must be split.
- **No implicit time/randomness**: inject `Clock` / `Rng` ports; tests must be reproducible.

### 2.7 Data flow and types

- Python boundary: `pydantic.BaseModel`; domain internal: `@dataclass(frozen=True, slots=True)`.
- TS boundary: `zod` schema + `z.infer<typeof S>`; domain internal: `readonly` types + `Object.freeze` (or `immer`).
- Prefer immutability; updates return new objects (Python `model_copy(update=...)` / `dataclasses.replace`; TS spread or `immer`).
- Do not pass raw `dict` / `Record<string, unknown>` across layers; pass strongly typed objects.

### 2.8 Quant domain specifics

- Price, quantity, amount: Python uses `Decimal`; TS uses `decimal.js` or `bignumber.js`. **Never use `number` for money.**
- Time uniformly `datetime` with tz (UTC), stored as ISO8601; no naive datetimes. Convert to `Asia/Shanghai` only for frontend display.
- Backtest / live share the same `Strategy` interface; the only difference is the adapter (`BacktestBroker` vs `LiveBroker`).
- All randomness must accept a `seed` parameter; an unseeded random call by default is a bug.
- **When daily K-line data is ingested**, the following must be precomputed and persisted: forward-adjusted prices (`open_qfq/high_qfq/low_qfq/close_qfq`) and `ma5/ma10/ma20/ma60` based on adjusted close. See `docs/modules/02-stock-kline.md`.

### 2.9 Multi-user and auth (mandatory)

- **User-scoped file storage uniformly uses `UserScopedJsonStore<T>` from `apps/api/src/common/user-scoped-store.ts`** — partitioned by `data/users/{userId}/...`. Any new "user-scoped" module (personal ledger, watchlist, personal preferences, etc.) must reuse this utility; do not roll your own mutex / atomic-write / throttle.
- **Shared market data stays in `data/<module>/...` shared directories**: kline / sectors / blacklist / sentiment / ta / meta / watch universe are not user-partitioned.
- **NestJS controllers obtain the user**: always via `@CurrentUser()` (`modules/auth/current-user.decorator.ts`) to get `AuthenticatedUser.id`; **never** let clients pass userId in body / query.
- **Service method signatures**: every user-scoped service method takes `userId: string` as its first parameter; DTOs do not contain userId.
- **`AUTH_MODE` switch**: `disabled` (default) injects an `admin` user; `oauth` uses Feishu. Both ends share the same code; the difference is in env.
- **userId derivation**: a single function `deriveUserId(provider, externalId, tenantKey)` (in `modules/auth/ports/oauth-provider.port.ts`). Both web login and IM entry must go through this so that the same person → the same userId.
- **IM command entry does not go through `AuthGuard`**: `AuthService.resolveFromIm` produces `AuthenticatedUser` directly; the dispatcher passes `userId` as the first arg to services. See `docs/integrations/auth.md`.
- **Python services are user-agnostic**: `services/py/quant_rpc/*` must never carry a `userId` field. All user partitioning happens in the NestJS frame.

### 2.10 Configuration / env (mandatory)

- **Every newly added runtime env variable (NestJS / Next.js / Python — any process) must be added to `.env.example` at the repo root**. It is the single source of truth for onboarding. Missing it = task incomplete.
- Template entry structure: ① one comment line above stating purpose + linked doc (`see docs/...`), ② default value / required-or-not, ③ optional enum or value range. **Do not** put real keys / tokens in the example.
- Variables of the same topic are grouped under one `# ---- <module> ----` section with a consistent header; new sections go right after the most related existing one.
- When deleting / renaming an env variable, also update `.env.example` and every doc referencing it (`docs/architecture.md` / `docs/integrations/*` / `README.md`). CI will not catch the misses for you.
- Variables shared with the frontend must start with `NEXT_PUBLIC_` and be dual-written in NestJS + Next.js (see the `AUTH_MODE` / `NEXT_PUBLIC_AUTH_MODE` pattern).
- Variables that require generating a key / long token must spell out the generation command (e.g. `openssl rand -hex 32`); don't make the user search for it.

---

## 3. Testing (hard)

### 3.1 Coverage and structure

- **New/modified code: line coverage ≥ 90%**, branch coverage ≥ 80%.
- Test directory mirrors the source directory:
  - Python: `services/py/quant_core/foo.py` ↔ `services/py/tests/quant_core/test_foo.py`
  - NestJS: `apps/api/src/modules/foo/foo.service.ts` ↔ `apps/api/test/modules/foo/foo.service.spec.ts`
  - Next.js: `apps/web/lib/foo.ts` ↔ `apps/web/__tests__/lib/foo.test.ts`
- Naming: `test_<function>_<scenario>_<expectation>` / `it("<scenario> should <expected>")`.

### 3.2 Test categories

| Type        | Python marker              | TS marker                      | Scope                              | Speed  |
| ----------- | -------------------------- | ------------------------------ | ---------------------------------- | ------ |
| unit        | `@pytest.mark.unit`        | `*.test.ts`                    | Single function/class, pure logic  | < 50ms |
| integration | `@pytest.mark.integration` | `*.spec.ts`                    | Cross-module, with real adapters   | < 1s   |
| e2e         | `@pytest.mark.e2e`         | `*.e2e-spec.ts` / `playwright` | Full entry                         | no cap |
| property    | `@pytest.mark.property`    | `fast-check`                   | Property tests                     | < 1s   |

CI runs unit + integration by default; e2e is triggered separately.

### 3.3 Required test scenarios

For every new/modified public function, cover:

1. **Golden path**: typical input → expected output
2. **Boundaries**: empty, zero, max, min, single element, negative (where applicable)
3. **Exception paths**: trigger every `raises` / `throws`
4. **Invariants**: dual / reversible / idempotent (where applicable)
5. **Regression**: every bug fix starts with a failing test that reproduces the bug

### 3.4 Test-quality rules

- One assertion per test; use parameterization / `it.each` to cover multiple datasets — no if/else branches.
- **No mocking the database** — use real sqlite / in-memory / testcontainer; mocks are only for external network and uncontrollable time/randomness.
- **Cross-process contract tests**: Python and TS share the schemas under `proto/`; any contract change updates tests on both sides.
- **Time and randomness must be controlled**: inject `FrozenClock` / `SeededRng`; avoid global patching.
- Each test ≤ 30 lines; split into fixtures / helpers if longer.
- Shared fixtures live in the nearest `conftest.py` / `test-utils/`.
- No mutable state shared between tests.

### 3.5 Commands

- All Python: `pytest -q`
- Python coverage: `pytest --cov=services/py --cov-branch --cov-report=term-missing --cov-fail-under=90`
- NestJS: `pnpm --filter api test` / `... test:cov`
- Next.js: `pnpm --filter web test`
- Full gate: `pnpm check` (aggregate script: prettier check + eslint + tsc + jest + vitest + ruff format check + ruff check + mypy strict + pytest cov)

---

## 4. Automatic review mechanism (hard)

### 4.1 Triggers

Trigger per §0 step 4 — do not engage indiscriminately. Summary:

- **Must trigger**: explicit user request (`/review` / "审一下"); milestone / feature wrap-up containing non-trivial business logic; cross-process contract (`proto/` / Arrow schema) change.
- **Do not trigger**: scaffolding, config tweaks, formatting, docs/comments, single-file small refactors where `pnpm check` is already green.
- The standing gate is `pnpm check`; reviewer is sampled, not invoked every time.

### 4.2 Review dimensions

The reviewer must check and grade each (pass / minor / major / blocker):

1. Violations of Chapter 1 code style (including language-specific)
2. Violations of Chapter 2 modularity layering (including process topology and cross-language contracts)
3. Test completeness (Chapter 3)
4. Security issues introduced (injection, unvalidated input, hard-coded keys/credentials, uncontrolled time/randomness, CORS/CSRF/SSRF)
5. Performance traps introduced (O(n²) on the hot path, IO in loops, unreleased resources, N+1, many small cross-process calls)
6. Breaking existing contracts (HTTP API, Arrow schema, Python public API)
7. Docs and logs updated in sync (especially `docs/integrations/*` and `docs/modules/*`)

### 4.3 Verdict format

```
Review of <files>:
- Style: PASS | MINOR(...) | MAJOR(...) | BLOCKER(...)
- Modularity: ...
- Tests: ...
- Security: ...
- Performance: ...
- Contracts: ...
- Docs/Logs: ...

Verdict: APPROVE | REQUEST_CHANGES
Required fixes (if any):
1. ...
```

`MAJOR` and `BLOCKER` must be fixed and re-reviewed until `APPROVE` — only then is the task done.

---

## 5. Tools and commands

### Python

| Task           | Command                                                     |
| -------------- | ----------------------------------------------------------- |
| Format         | `ruff format . && ruff check --fix .`                       |
| Type check     | `mypy --strict services/py`                                 |
| Unit test      | `pytest -q -m "unit or integration"`                        |
| Coverage       | `pytest --cov=services/py --cov-branch --cov-fail-under=90` |

### TypeScript

| Task             | Command                                          |
| ---------------- | ------------------------------------------------ |
| Format           | `pnpm prettier --write . && pnpm eslint --fix .` |
| Type check       | `pnpm -r tsc --noEmit`                           |
| Unit test (API)  | `pnpm --filter api test`                         |
| Unit test (Web)  | `pnpm --filter web test`                         |
| E2E              | `pnpm --filter web test:e2e` (playwright)        |

### Full gate

- `pnpm check`: aggregate script in the root `package.json`. Runs TS stack (prettier check + eslint + tsc + jest + vitest) and Py stack (`uv run`-wrapped ruff format check + ruff check + mypy --strict + pytest --cov) in sequence; any failure exits non-zero.

---

## 6. Git and commits

- One commit does one thing; title ≤ 72 chars, imperative. Conventional prefixes: `feat:` / `fix:` / `refactor:` / `test:` / `docs:` / `chore:`.
- No `git commit --no-verify` (unless the user explicitly asks).
- No `git push --force` to `main` / `master`.
- Commit body explains "why", not "what" — the latter is in the diff.
- Cross-process contract changes (`proto/`, Arrow schema, HTTP API) must be in their own commit, with title prefix `contract:`.

---

## 7. When this spec conflicts with the request

- A user's specific instruction > this spec's generic clauses; but **safety/correctness clauses are non-negotiable** (hard-coded keys, empty tests, skipping type checks, etc. must always be refused with explanation).
- When unsure, ask — do not silently drift.

---

## 8. Cross-process contracts (mandatory)

### 8.1 Single source of schema

- All Python ↔ NestJS data structures are defined under `proto/`:
  - Arrow schemas (`.fbs` or JSON generated from `pyarrow.Schema`) for bulk columnar payloads (K-lines, news lists, etc.)
  - Control-plane messages (requests, params, errors) in protobuf `.proto`
- A code generator emits both Python (pydantic classes) and TS (zod schema + types). Hand-written schemas on either side are rejected.

### 8.2 Error-code table

- All cross-process error codes are centralized in `proto/errors.proto` (or equivalent JSON), pulled into both sides via the generator.
- Errors must carry `code` (machine-readable, UPPER_SNAKE_CASE), `message` (human-readable), `details` (structured fields, optional), `trace_id`.

### 8.3 Versioning and compatibility

- Schema changes follow semantic versioning: additive fields (backward-compatible) → minor; deletions/renames → major, requiring a migration note + dual-write window.
- Every schema change requires new contract tests: old client against new server / vice versa, asserting behavior matches the compatibility statement.

### 8.4 Call conventions

- Long tasks (> 2s) must return a `task_id`; poll via SSE / polling — do not hold an HTTP connection open.
- Large payloads (> 1MB) must go through the Arrow Flight columnar channel; do not stuff into JSON.
- Frequent small calls must be batched (pass a list of symbols once; don't call N times in a loop).

---

## 9. General engineering principles (mandatory)

### 9.1 Data normalization

- A concept has exactly one canonical representation system-wide; normalize before entering the business layer:
  - Amount / price / quantity: `Decimal` / `decimal.js` with uniform precision and rounding strategy.
  - Enums: defined in `proto/` or core types directories; no scattered literals.
- Normalization functions live in core directories (`domain/pure/` or `packages/shared/fp/`) and are called solely from the boundary layer (adapters / dto); the business layer assumes data is normalized and does not re-clean.
- External input (HTTP / RPC / file) is validated + normalized in one shot at the boundary before entering the domain; no "fix as you use".

### 9.2 Pluggable modules and test doubles

- Business modules program against external dependencies (data sources, caches, LLMs, brokers, clock, rng, etc.) via **ports (Protocol / abstract interfaces)** rather than concrete SDKs; adapters are registered at the wiring layer (NestJS `Module` / Python `services` factory / Next.js DI container).
- Cost of swapping an implementation must be 0: replacing one adapter requires no changes to service / domain / callers.
- Every port has a production adapter AND at least one test double (`FakeXxx` / `InMemoryXxx`); doubles live in `tests/fakes/` or `test-utils/` and behave equivalently to the real adapter at the boundary.
- Importing a concrete adapter or SDK in service / domain is forbidden; violation = MAJOR.
- Config-driven selection: which adapter is chosen is decided by env / config — do not write `if env === 'test'` branches in code.

### 9.3 Performance is the top priority

- Before writing code, estimate the hot-path complexity and data scale; pick the right data structure and algorithm — don't write first and optimize later.
- The hot path must not contain: IO in loops, N+1 queries, unnecessary repeated JSON parsing, many small cross-process calls (see §8.4 for batching), or list/table UI without virtualization.
- **Do not shard Parquet by business key into ≥ 1000 files**: DuckDB `read_parquet(list-of-N-paths)` scheduling overhead becomes significant for N > a few hundred; 5500 per-code parquet files for A-shares is the anti-pattern. Instead, shard by prefix into ≤ 50 flat `<prefix>.parquet` files + whole-partition rewrite on write. Benchmark: `docs/perf/kline-write.md`.
- **Daily batch jobs don't need LSM/delta for "write latency"**: a measured 50 ms whole-file rewrite is fast enough; the ops cost of delta + compaction (runaway-delta alerts, compaction cron, deeper folder hierarchy) is not worth it. Unless write QPS exceeds what a single rewrite can sustain, always rewrite. Same benchmark.
- Large objects go through columnar (Arrow); hot queries go through indexes / precomputation (e.g. daily forward-adjusted prices and `ma*` computed at ingest time — see §2.8); idempotent results go through cache.
- Any "seemingly innocuous" loop / map / filter must be re-evaluated when N ≥ 1e4; prefer streaming / chunked processing over loading the full table.
- Performance-related code must have a reproducible benchmark (micro-benchmark / load test); changes need before/after numbers — no "feels faster" judgments.

### 9.4 Performance optimization log

- Every performance change must leave a record under `docs/perf/<topic>.md` containing:
  1. Context and bottleneck identification (profile screenshots / logs / metrics)
  2. Approach and trade-offs (why A, not B)
  3. Quantified results (before/after: p50 / p95 / throughput / memory — the more specific the better)
  4. Regression risk and monitoring points
- After the doc is in place, write back any reusable lesson, gotcha, or "never do this again" as a one-line rule into the appropriate section of this `AGENTS.md` (usually §9.3 or §2 modularity), keeping this file the source of truth.
- An optimization without quantified results counts as incomplete; "I think it's faster" is not grounds for merging to main.

---

## 10. Accessibility (a11y) — hard rules for any UI change

The frontend is keyboard-first. Every interactive surface must be reachable, operable, and announceable without a mouse. Violations are MAJOR by default; a control that is mouse-only is BLOCKER.

### 10.1 Keyboard reachability (mandatory)

- Every action a user can perform with a click must also be triggerable via the UI command set (see §10.5). No exception for "small" buttons, icon buttons, popovers, or dropdown items.
- Tab order must follow visual order. Do NOT set `tabIndex > 0`. Use `tabIndex={0}` only on non-native interactive elements (`div` with `role="button"`, etc.) and `tabIndex={-1}` for programmatic focus targets.
- Custom keyboard handlers must not swallow `Tab` / `Shift+Tab` / `Escape` unless the surface is a modal / menu / combobox that legitimately traps focus.
- Every Feat that captures keyboard input must register its bindings through `useFeatHotkeys` (§10.5); ad-hoc `window.addEventListener('keydown', ...)` in components is forbidden.

### 10.2 Semantics and ARIA

- Prefer native semantic elements: `<button>` for actions, `<a>` for navigation, `<input>`/`<label>` for fields, `<nav>`/`<main>`/`<aside>` for landmarks. Reach for `role="..."` only when no native element fits.
- Icon-only controls must have `aria-label` (or visually-hidden text). Decorative icons must have `aria-hidden="true"`.
- Live regions (`role="status"` / `aria-live="polite"`) are required for async progress, toast-style notifications, and SSE-driven updates.
- Dialogs use `role="dialog"` + `aria-modal="true"` + initial focus on the first interactive element + focus restore on close.

### 10.3 Visible focus + motion

- Every focusable element must have a visible focus ring with contrast ≥ 3:1 against the adjacent background. `outline: none` without a replacement style is BLOCKER.
- All non-essential motion must respect `@media (prefers-reduced-motion: reduce)` — disable transforms / opacity transitions > 200 ms.
- Color must never be the sole carrier of meaning (use icon + text + color). Text/background contrast WCAG AA (≥ 4.5:1 body, ≥ 3:1 large text).

### 10.4 Forms and errors

- Every input has a programmatically-associated `<label>` (or `aria-labelledby`). Placeholder-only labelling is forbidden.
- Validation errors are announced via `aria-describedby` referencing the error element, and the error element has `role="alert"` when it appears.
- Disabled buttons are NOT the default — prefer enabled + run validation on click, so screen-reader users can hear the error.

### 10.5 The UI command set (single source of truth for all UI actions)

The frontend exposes every user-actionable operation as a **cell** in [apps/web/lib/instructions/](apps/web/lib/instructions/) — the same registry used by Terminal and AI. The instruction registry is the **superset**: it powers Terminal input, AI tool calls, mouse clicks, AND keyboard shortcuts. Hand-rolled parallel registries are rejected.

- Every cell that has a UI affordance carries a `ui` block: `{ scope, keys?, label, group, when? }`. `scope` is `'global'` or a `Feat` value (see [feat.ts](apps/web/lib/eqty/feat.ts)).
- Keystrokes follow the **Vim sequence style**: lowercase letter sequences (`g m`, `d d`, `y y`), no modifiers for navigation/view ops, `shift+letter` only for destructive operations (`D` = delete-with-confirm). `Esc` cancels the in-progress sequence. `?` opens the shortcut hint window.
- Module switching is a global scope cell (e.g. `g m` → focus `MKT`, `g e` → focus `EQ`). Focused module = `activeFeat` in the store.
- A Feat receives its module-scope keymap on focus and releases it on blur — wire via `useFeatHotkeys(feat, handlers)`. Never bind a module-scope key globally.
- Buttons / menu items in JSX must dispatch through the command system (`<CmdButton cmd="sector.remove-stock" />` or `useCommand('sector.remove-stock')`). Direct `onClick={() => service.remove(...)}` for an operation that already exists as a cell is a MAJOR — it diverges mouse path from AI/keyboard path.
- The floating shortcut hint window (`FeatHotkeyHint`) is required: it subscribes to the active scope and renders the available bindings grouped by `group`. It must itself be keyboard-accessible and minimizable.
- Pure UI-only operations (focus next module, toggle fullscreen, minimize, open hint) are also cells — their dispatcher runs purely on the frontend (`fe-center.ts`); they do not call the API.

### 10.6 Testing and review

- The `a11y-reviewer` subagent runs on every UI-touching change set (auto-fired by the `auto-review` skill). It is a static check; failing it blocks merge of UI work.
- For each new interactive component, the author must list in the PR description: (a) the cell(s) backing it, (b) the keystroke (if any), (c) the `aria-label` of any icon-only control.
- When Codex asks the user to "test the UI", testing must include: tab through the surface with keyboard only; trigger the cell via the shortcut; verify the hint window lists it. Mouse-only verification is insufficient.
