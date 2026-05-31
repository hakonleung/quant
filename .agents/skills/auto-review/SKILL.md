---
name: auto-review
description: Run the full automatic review pipeline on the current change set — style, type checks, tests with coverage, then the code-reviewer subagent. Handles both Python (ruff/mypy/pytest) and TypeScript (eslint/tsc/jest/vitest) plus cross-process contract tests. Use after finishing any code change in this repo, or whenever the user says "review", "check", "审", "review一下". Returns a single PASS/FAIL verdict with required fixes.
---

# Auto Review Pipeline

You enforce `AGENTS.md` end-to-end on the current change set. Run all gates. Do not stop on the first failure — collect everything and report once.

## Steps

### 1. Identify what changed

```bash
git status -s
git diff --name-only HEAD
```

Classify changed files into:

- Python (`services/py/**/*.py`)
- NestJS (`apps/api/**/*.ts`)
- Next.js (`apps/web/**/*.{ts,tsx}`)
- Shared (`packages/**/*.{ts,tsx}`)
- Cross-process (`proto/**`)
- Docs only (`docs/**`, `*.md`)

If only docs changed → skip Static + Tests gates, jump to step 4 (reviewer).

### 2. Static gates (run in parallel where possible)

**Python (only if Py files changed)**:

```bash
ruff format --check .
ruff check .
mypy --strict services/py
```

**TypeScript (only if TS files changed)**:

```bash
pnpm prettier --check .
pnpm eslint .
pnpm -r tsc --noEmit
```

**Cross-process (only if proto/ changed)**:

- Verify codegen ran: check that generated TS / Py files in `proto/` have matching mtime ≥ `.proto` files
- If not: FAIL with instruction `pnpm proto:gen` (or whatever the project script is)

Capture exit code per gate. Show the first 20 lines of failing output.

### 3. Tests + coverage

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

**Cross-process contract** (only if proto/ or rpc/adapters changed):

```bash
pytest -q -m contract
```

If test suite missing for changed files → FAIL → invoke `test-generator` agent first, then re-run this step.

### 4. Subagent review

Invoke the `code-reviewer` agent with a clear prompt:

> Review the current change set against AGENTS.md and docs/. Files: <list from step 1, classified by layer/process>. Apply the multi-language checklist. Return verdict per the format in your agent definition.

Capture its output verbatim.

**If the change set touches any `.tsx` / `.jsx` file under `apps/web/` or `packages/ui/`, OR any CSS that affects focus/contrast, ALSO invoke the `a11y-reviewer` agent in parallel** (single message, two Agent tool calls):

> Review the UI changes in the current change set against AGENTS.md §10. Files: <UI subset>. Return verdict per the format in your agent definition.

Capture both agents' outputs verbatim. If `a11y-reviewer` returns REQUEST_CHANGES with any `MAJOR` or `BLOCKER`, the overall verdict is REQUEST_CHANGES regardless of code-reviewer's result.

### 5. Verdict aggregation

```
# Auto Review Result

## Static
- ruff format:    PASS | FAIL | n/a
- ruff check:     PASS | FAIL | n/a
- mypy strict:    PASS | FAIL | n/a
- prettier:       PASS | FAIL | n/a
- eslint:         PASS | FAIL | n/a
- tsc --noEmit:   PASS | FAIL | n/a
- proto codegen:  PASS | FAIL | n/a

## Tests
- pytest:         PASS | FAIL  (N tests, M failures)
- jest (api):     PASS | FAIL  (...)
- vitest (web):   PASS | FAIL  (...)
- contract:       PASS | FAIL  (...)
- coverage py:    XX% (gate 90%)
- coverage api:   XX% (gate 90%)
- coverage web:   XX% (gate 90%)

## Reviewer agent
<verbatim verdict block>

## A11y reviewer (UI changes only; n/a otherwise)
<verbatim verdict block or "n/a — no UI files changed">

## Final: APPROVE | REQUEST_CHANGES

## Required fixes (ordered)
1. <file:line> — <action>
2. ...
```

`APPROVE` only when **every** gate passes AND reviewer says `APPROVE`. Otherwise `REQUEST_CHANGES`.

## When to use

- After every coding task, before declaring it done.
- On `/review`, `/check`, "审一下", "review 这次改动", "跑下检查".
- Before any commit if the user asks you to commit.

## When not to use

- Pure documentation-only changes can skip Static + Tests but still run reviewer for the doc dimensions.
- Discovery / read-only sessions (no edits).
