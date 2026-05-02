---
name: generate-tests
description: Generate tests for recently changed source files following CLAUDE.md §3 — golden path, boundaries, every raise/throw, invariants, regression. Handles Python (pytest), NestJS (Jest), Next.js (vitest + RTL), and cross-process contracts. Use after writing or modifying any source file under services/py/, apps/api/src/, apps/web/, packages/, or proto/. Delegates to the test-generator subagent and runs the new tests.
---

# Generate Tests

Creates rigorous tests for the current change set, mirroring source paths under the matching test root.

## Steps

### 1. Find changed source files

```bash
git diff --name-only HEAD -- \
  'services/py/**/*.py' \
  'apps/api/src/**/*.ts' \
  'apps/web/**/*.ts' 'apps/web/**/*.tsx' \
  'packages/**/*.ts' \
  'proto/**'
```

If empty, ask the user which files need tests.

### 2. Delegate to the test-generator agent

Invoke the `test-generator` subagent with:

> Generate or extend tests for these files according to CLAUDE.md §3:
> <list of source files, classified by Python / NestJS / Next.js / shared / cross-process>
>
> Required scenarios per public symbol: golden path, boundaries, every `raises` / `throws`, invariants, regression.
> Use mirrored paths. Use the right runner per layer:
>
> - Python → pytest with the right marker (unit / integration / contract / property)
> - NestJS → Jest in `apps/api/test/`
> - Next.js → vitest in `apps/web/__tests__/`
> - Cross-process → contract test in `services/py/tests/contract/`
>
> For core-asset modules (`domain/`, `lib/{fp,types}/`, `packages/shared/`), use **zero mocks**. If mocks are needed, surface back instead of silently adding them.
> Run the tests after writing and report coverage delta.

### 3. Verify gates

After the agent returns, run the relevant gates:

```bash
# Python
pytest -q -m "unit or integration" --cov=services/py --cov-branch --cov-report=term-missing --cov-fail-under=90

# NestJS
pnpm --filter api test:cov

# Next.js
pnpm --filter web test:cov

# Contract
pytest -q -m contract
```

### 4. Output

Pass through the agent's report. If a coverage gate fails, send the agent back with the missing-line list per file.

## When to use

- Any time `services/py/**`, `apps/api/src/**`, `apps/web/**`, `packages/**`, or `proto/**` was edited and the matching test root was not updated in lockstep.
- On user prompts: "写测试", "加 test", "test it", "/test".

## When not to use

- For trivial doc/comment-only edits.
- For test-only changes (run `/run-tests` instead).
