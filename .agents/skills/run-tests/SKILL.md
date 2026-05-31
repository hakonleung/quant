---
name: run-tests
description: Run the project's test suite with coverage and report results. Handles Python (pytest), NestJS (Jest), Next.js (vitest + Playwright), and cross-process contracts. Use whenever the user wants to verify tests pass, after edits to source or tests, or on prompts like "run tests", "跑测试", "/test". Reports failures with file:line and the coverage gate result.
---

# Run Tests

## Steps

### 1. Detect what needs to run

Check `git diff --name-only HEAD` to scope the run:

| Changed paths        | Runner                                     |
| -------------------- | ------------------------------------------ |
| `services/py/**`     | pytest                                     |
| `apps/api/src/**`    | jest (`pnpm --filter api test`)            |
| `apps/web/**`        | vitest (`pnpm --filter web test`)          |
| `packages/shared/**` | both jest & vitest (suites that import it) |
| `proto/**`           | pytest contract suite                      |

If user named a file or directory, scope to it.

If nothing changed → run everything: `pnpm check` (root aggregate script that runs all TS + Py gates).

### 2. Commands

**Python**:

```bash
pytest -q -m "unit or integration" \
  --cov=services/py --cov-branch --cov-report=term-missing --cov-fail-under=90
```

**NestJS**:

```bash
pnpm --filter api test:cov
```

**Next.js**:

```bash
pnpm --filter web test:cov
```

**Cross-process contract**:

```bash
pytest -q -m contract
```

**E2E (Playwright)** — only on explicit request or `--e2e`:

```bash
pnpm --filter web test:e2e
```

### 3. On failure

- Show first 30 lines of each failing test's traceback / error.
- Group failures by file.
- Do **not** auto-fix source code unless the user asked. Surface failures clearly.
- For coverage misses, list specific uncovered lines per file.

### 4. Output format

```
# Test Run

## Commands
- pytest ...                         → PASS | FAIL  (N passed, M failed, K skipped, Ts)
- pnpm --filter api test:cov        → ...
- pnpm --filter web test:cov        → ...
- pytest -m contract                → ...

## Coverage
- services/py:          XX% (gate 90%) — PASS | FAIL
- apps/api:             XX% (gate 90%) — PASS | FAIL
- apps/web:             XX% (gate 90%) — PASS | FAIL

## Failures
- services/py/tests/quant_core/test_foo.py::test_x_y_z
  <30-line traceback>
- apps/api/test/modules/screen/screen.service.spec.ts > "should ..."
  <30-line error>

## Missing coverage
- services/py/quant_core/foo.py:42-58
- apps/api/src/modules/screen/screen.service.ts:101-115
```

## Hard rules

- Never use `pytest -x` / `--bail` to hide failures; show them all.
- Never delete or skip a failing test to make a run green.
- If a runner is missing, tell the user how to install rather than silently switching.
- Do not run E2E by default; it's slow and flaky against external deps.
