---
name: update-docs
description: Sync docs/ and README.md with the latest code changes. Use when the user asks to "update docs", "更新文档", "同步文档", or after a non-trivial feature / refactor that affects the surface described in docs (modules, contracts, caching, data flow, frontend feats). Inspects uncommitted diff + the last N commits and patches only the docs whose claims drifted.
---

# Update Docs

Keep `docs/` and `README.md` aligned with the **current** state of the code. Touch nothing outside docs.

## Inputs

By default:

- Uncommitted changes: `git status -s` + `git diff HEAD`
- Last 5 commits: `git log --oneline -5` + `git log -p -5 --stat`

User can override via args (e.g. `last 10 commits` / a feature branch name).

## Doc surface to consider

```
README.md
docs/architecture.md
docs/requirements.md
docs/glossary.md
docs/modules/01-stock-meta.md       — meta sync, parquet store
docs/modules/02-kline.md            — qfq + ma precompute, watermark
docs/modules/03-screen.md           — DSL + NL2DSL
docs/modules/04-pattern.md          — DTW, full-universe scan
docs/modules/05-sentiment.md        — LLM web_search, 2d TTL
docs/modules/06-watch.md            — minute quotes, edge-trigger hits
docs/modules/07-orchestration.md    — cron + in-memory queue
docs/modules/08-frontend.md         — Feat / FeatView, MODULE.FEATURE registry
docs/modules/09-notifications.md    — slack webhook + dedupe
docs/integrations/data-sources.md   — akshare adapters
docs/integrations/llm-providers.md  — OpenAI-compat clients
docs/integrations/ipc-py-ts.md      — Arrow Flight ops list
docs/integrations/cache-strategy.md — parquet + file KV invariants
docs/rfcs/*.md                      — historical; only edit the status banner if newly implemented/superseded
```

## Procedure

1. **Gather signals**
   ```bash
   git status -s
   git log --oneline -5
   git log -p -5 --stat -- 'apps/' 'services/' 'packages/' 'proto/'
   git diff HEAD -- 'apps/' 'services/' 'packages/' 'proto/'
   ```
   Skip pure-test / pure-style changes — they don't shift docs.

2. **Classify each change** into one of:
   - **Surface** (public API / route / Arrow Flight op / DSL node / error code / Feat name) → likely doc impact
   - **Behaviour** (cache TTL, retry policy, edge-trigger semantics, default window) → likely doc impact
   - **Internal** (refactor, rename of private symbol, perf tune) → usually no doc impact

3. **Map to doc files** using the surface table above. For each change pick the smallest doc set:
   - new RPC op → `integrations/ipc-py-ts.md` op table + the owning module file
   - new Feat / Feat rename → `modules/08-frontend.md` Feat table
   - cache TTL / invariant change → owning module file + `integrations/cache-strategy.md`
   - new dependency / startup command → `README.md` + `architecture.md`
   - error code added → mention only if it changes a publicly-quoted code

4. **Edit, don't rewrite.** Use Edit tool, keep tone and structure. Preserve the table-heavy, terse style. Do not expand sections that didn't change.

5. **Cross-check**:
   - Module file paths in tables match real files (`ls services/py/...`, `ls apps/web/components/`).
   - Dep versions in README match `pyproject.toml` / `package.json`.
   - No reference to removed tech (Redis / BullMQ / LangGraph / news local cache).

6. **Report** in this exact shape:
   ```
   Docs updated:
   - <file>: <one-line reason tied to commit/diff>
   ...
   No-op:
   - <commit/file>: <why no doc impact>
   ```

## Hard rules

- Don't touch code, tests, or `CLAUDE.md`.
- Don't add aspirational ("will / TODO / 计划") content — docs describe **current** state.
- Don't expand a doc just because you opened it. Single-purpose edits.
- RFCs are historical; only edit the status banner at the top when implementation status genuinely changed.
- If a commit deletes a feature, delete its doc references — don't leave dangling links.
- If a commit only touches tests / fixtures / configs / formatting → no doc edit.
