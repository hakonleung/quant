# `/agent` v1 — review & test checklist

This is what you need to inspect, configure, and exercise to validate v1.
The commit list, intentional v1 simplifications, and deferred follow-ups
are all spelled out below.

## Commit map

```
129f66c  test(agent): cover stream events + agent module + IM fallback + feishu cards
6c34497  feat(agent): terminal /agent command + streaming engine events + web socket bridge
edf78f0  feat(agent): IM fallback to /agent + paid-confirm card + /usr ledger summary
2c298ca  feat(agent): /agent multi-step loop + /agent.confirm continuation
0a85cf0  feat(instruction): InstructionSpec costsCredits/destructive + agent shared schemas
f4d8f01  feat(ledger): migrate /analyze LLM call from Python to NestJS
685cfb2  feat(screen): migrate NL→DSL translation from Python to NestJS
7dee644  feat(llm): NestJS LlmService foundation + user token ledger
```

## Static gates (already green)

- [x] `pnpm -r typecheck` — every workspace clean
- [x] `pnpm --filter @quant/api test` — 307 / 44 passing
- [x] `pnpm --filter @quant/terminal test` — 219 / 20 passing
- [ ] `pnpm --filter @quant/shared test` — 4 *pre-existing* failures
  in `eqty.test.ts` / `stock-meta.test.ts`. They fail on `main` before
  this work too — confirmed by stashing all my changes and re-running.
  Not introduced by v1 and not blocking; please cross-check on a clean
  branch.

## Configuration you must set before testing

### Required env

```bash
# Pick one provider with a key in env. Catalog priority is qwen → deepseek → moonshot.
export QWEN_API_KEY=...      # OR DEEPSEEK_API_KEY OR MOONSHOT_API_KEY

# Recommended for /agent — Moonshot or Qwen support web search.
export AGENT_LLM_PROVIDER=moonshot        # optional override
export AGENT_LLM_API_KEY=$MOONSHOT_API_KEY  # optional override
# AGENT_LLM_MODEL / AGENT_LLM_BASE_URL / AGENT_LLM_WEB_SEARCH_KIND
# all optional — fall back to the catalog row.

# Optional knobs
export AGENT_MAX_TOOL_CALLS=5            # 1..10, default 5
export LLM_REQUEST_TIMEOUT_MS=60000      # default 60s
export QUANT_LLM_LEDGER_DIR=../../data   # where llm-ledger.json lands
```

### IM allowlist (recommended for the IM fallback)

```bash
export INSTRUCTION_IM_ALLOWLIST=feishu:ou_<your_open_id>,slack:U_<your_id>
```

Without this, every IM sender can trigger the `/agent` paid path.

## CLAUDE.md amendments to read

- §2.1: external LLM clients now live in NestJS; Python keeps pure
  compute + IO.
- §1.4: structured `provider / model / scope / usage / durationMs /
  traceId / userId` fields on every LLM call log line.
- §2.2: `services/py/quant_workflow/` LangGraph package re-framed as
  v2 (reverse-RPC into NestJS).

## Code review checklist

### LLM substrate (commit `7dee644`)

- [ ] `apps/api/src/modules/llm/llm.config.ts` — env loader merging
  `LLM_*` defaults with `AGENT_LLM_*` per-scope override.
- [ ] `apps/api/src/modules/llm/providers.ts` — Qwen/DeepSeek/Moonshot
  catalog with CNY pricing; `priceCallCny()`.
- [ ] `apps/api/src/modules/llm/adapters/openai-compatible.client.ts`
  — `chatWithTools`, `chatStreamFinalize`, `completeJson`.
- [ ] `apps/api/src/modules/llm/web-search/moonshot-tool-loop.ts` —
  `$web_search` builtin_function tool loop, hard-cap at 4 searches.
- [ ] `apps/api/src/modules/llm/web-search/qwen-extra-body.ts` —
  single-shot `enable_search` streaming.
- [ ] `apps/api/src/modules/llm/ledger/user-llm-ledger.store.ts` —
  append-only `data/users/{userId}/llm-ledger.json` with per-scope
  aggregation.
- [ ] `apps/api/src/modules/llm/ledger/llm-ledger.recorder.ts` —
  fire-and-forget recorder; failed LLM calls also recorded.
- [ ] `apps/api/src/modules/llm/llm.service.ts` — provider resolution
  + structured logging + ledger hookup.

### Migrated callers (commits `685cfb2`, `f4d8f01`)

- [ ] `apps/api/src/modules/screen/nl-to-dsl.service.ts` — verbatim
  port of the Python prompt + 1-retry loop.
- [ ] `apps/api/src/modules/screen/op-to-kind.ts` — op-tagged →
  kind-tagged AST converter (mirror of Python `screen_parse` +
  `universe_parse`).
- [ ] `apps/api/src/modules/screen/screen.service.ts` — `runNl` does
  NL→DSL in NestJS, then dispatches `screen_run` Flight op.
- [ ] `apps/api/src/modules/screen/screen.controller.ts` — `userId`
  threaded through via `@CurrentUser()`.
- [ ] `apps/api/src/modules/ledger/ledger.service.ts` — `analyze()`
  calls `LlmService.completeJson(scope='analyze')` directly; Flight
  client + `ledger.token.ts` deleted.
- [ ] `apps/api/src/modules/ledger/prompts/analyze.prompt.ts` —
  verbatim port of `ledger_prompts.py`.

### Agent module (commits `0a85cf0`, `2c298ca`, `edf78f0`)

- [ ] `packages/shared/src/instructions/agent-history.ts` — role +
  content + ts envelope.
- [ ] `packages/shared/src/instructions/agent-tool-call.ts` —
  proposal envelope used in confirm cards.
- [ ] `packages/shared/src/types/socket.ts` —
  `instruction.agent.delta` topic with 5-kind discriminated union
  (`step / tool_result / confirm / text / done`).
- [ ] `packages/shared/src/instructions/result.ts` —
  `confirm-required` error code added.
- [ ] `apps/api/src/modules/instruction/instruction.types.ts` — new
  `costsCredits` + `destructive` spec flags. `/screen` `/analyze`
  carry `costsCredits=true`; `/blacklist update` `destructive=true`.
- [ ] `apps/api/src/modules/agent/agent.service.ts` — the loop.
- [ ] `apps/api/src/modules/agent/agent-tool-bridge.ts` — registry →
  ChatTool + ChatToolCall → `InstructionExecutor.execute`. Includes
  the narrow `zodToJsonSchema` helper so we don't pull a 30 KB dep.
- [ ] `apps/api/src/modules/agent/agent-history.store.ts` —
  per-(userId,channel) ring buffer + `CHANNEL_INBOUND_EVENT` capture.
- [ ] `apps/api/src/modules/agent/agent-pending.store.ts` —
  correlationId-keyed snapshot store with 5-min TTL sweep.
- [ ] `apps/api/src/modules/agent/instructions/agent.handler.ts` —
  paid-confirm intercept + detached loop launch.
- [ ] `apps/api/src/modules/agent/instructions/agent-confirm.handler.ts`
  — correlationId continuation; rejects cross-user resume.
- [ ] `apps/api/src/modules/agent/prompts/system-prompt.ts` — Chinese
  A 股 helper persona with live tool catalog injection.
- [ ] `apps/api/src/modules/agent/agent.module.ts` registered in
  `app.module.ts` (ordered after `TaModule`).
- [ ] `apps/api/src/modules/instruction/instruction.im.listener.ts` —
  `parseLine` silent fallback to `/agent`; `confirm-required` →
  `agent.paid_confirm` card kind.
- [ ] `apps/api/src/modules/channel/adapters/feishu-card.ts` —
  `buildAgentPaidConfirmCard`, `buildAgentToolProposalCard`, purple
  template, paste-back command bodies.
- [ ] `apps/api/src/modules/instruction/handlers/usr.handler.ts` —
  injects `UserLlmLedgerStore`; renders today / month / total
  + per-scope CNY breakdown.
- [ ] `apps/api/src/modules/instruction/handlers/help.handler.ts` —
  `[$]` / `[!]` tags in the list + detail views.

### Terminal + Web (commit `6c34497`)

- [ ] `packages/terminal/src/engine/state.ts` — `OutputEntry.streaming`
  + 4 stream events.
- [ ] `packages/terminal/src/engine/reducer.ts` — pure handlers for
  the 4 events; idempotent open, no-op on unknown id, footer + status
  on close.
- [ ] `packages/terminal/src/registry.ts` — `CommandCtx.dispatchEvent`.
- [ ] `packages/terminal/src/actions/types.ts` —
  `DataActionRunner.invokeBeInstruction` + `subscribeAgentDelta` +
  `AgentDeltaFrame` mirror.
- [ ] `packages/terminal/src/commands/agent.ts` — confirm widget +
  socket call + frame → engine event mapping + Ctrl+C unsubscribe.
- [ ] `apps/web/lib/socket/socket-client.ts` — `sendSocketCommand`.
- [ ] `apps/web/lib/term/live-runner.ts` — wires
  `invokeBeInstruction` + `subscribeAgentDelta` against the socket
  singleton.
- [ ] `apps/web/components/feat-term-main/use-terminal.ts` — passes
  `dispatchEvent` into `CommandCtx` via a forward ref.

## Manual test plan

> Boot order: `pnpm dev:api`, `pnpm dev:web`, `uv run python -m
> quant_rpc.main`. Confirm at least one `*_API_KEY` is set.

### Term

1. **Smoke:** open the terminal, type `agent`. Expect `agent 需要一句话提示词` error.
2. **Paid confirm widget:** `agent 茅台基本面` → confirm widget shows
   the prompt; `Y` continues, `N` cancels.
3. **Single-tool path:** `agent 茅台基本面` → after Y, expect
   ```
   ▶ /focus 600519
   ✓ focus
   <focus result>
   <streamed final answer>
   —— 1 轮工具调用，token: in=… out=… total=…，¥ 0.0xxx
   ```
4. **Multi-tool path:** `agent 近5日涨幅前10的银行股，再看下板块情绪` →
   Y → expect a confirm step listing the proposed `/screen ...`
   call (because `/screen` is `costsCredits`). Paste back
   `agent.confirm correlationId=<X> approve=1` → loop resumes →
   final answer.
5. **Cancel:** at the second confirm, paste `approve=0` → loop emits
   "用户已取消..." and a final summary.
6. **MAX_TOOL_CALLS guard:** lower env `AGENT_MAX_TOOL_CALLS=1`, run
   a multi-step prompt → expect a forced final answer + footer
   noting "[已达 1 步工具调用上限]".
7. **Ctrl+C unsubscribes:** during streaming, hit Ctrl+C → stream
   closes locally with "(已取消订阅, BE loop 仍在后台运行)" footer.
   Backend keeps running; ledger eventually records the spend.
8. **`/usr`** before / after a run: expect today's CNY total to grow
   by `cnyCost` from the most recent `done` frame. Per-scope line
   shows `agent` + `screen` separately.
9. **`/help`** lists `[$]` next to `agent`, `screen`, `analyze`; `[!]`
   next to `update`.

### IM (Feishu)

1. **Allowlist set, casual chat:** send "看看茅台" → bot replies with
   the purple **paid-confirm** card containing the original q + a
   copy-paste `/agent confirm=1 q="..."` command.
2. **Paste back the confirm command** in the same chat → agent loop
   runs; intermediate frames + final answer arrive as plain messages
   (Slack-side cards on Feishu would be cleaner; v1 keeps it simple).
3. **Multi-tool with paid intercept:** send `/agent confirm=1 q="近5日涨幅前10的银行股"`
   → expect the second purple card (tool proposal) with copy-paste
   approve / cancel commands.
4. **Non-allowlisted sender** sends "看看茅台" → bot stays silent.
5. **`/usr`** in IM shows the same ledger summary the term shows.
6. **Slack** behaves like Feishu but without the purple card —
   adapter falls through to plain text. (Slack interactive button
   support is the v1.5 follow-up.)

### LLM ledger sanity

- After 2-3 runs: `cat data/users/<userId>/llm-ledger.json` should
  show JSON-Lines-like entries (an array under `entries`) with
  ascending timestamps, non-zero `cnyCost` on success, zero on
  failure, and `scope` in `{agent, screen, analyze}`.

## Intentional v1 simplifications (worth a second look)

- **Feishu interactive buttons → paste-back commands.** The card
  body shows the exact `/agent confirm=1 q="..."` /
  `/agent.confirm correlationId=… approve=…` strings; users copy &
  send. This avoids the SDK / app-config work needed for true
  `card.action.trigger` callbacks. Real buttons land in v1.5.
- **No Slack interactive button.** Same reason; Slack falls through
  to plain text. Tracked alongside Feishu buttons.
- **No reasoning visualization.** The agent surfaces tool steps +
  final text only; LLM internal reasoning chains are deferred to v2.
- **Token ledger is read-only.** No quota cap, no rate limit, no
  reset command. `/usr` shows the spend; that's it. Matches the v1
  decision you made earlier.
- **Streaming text shows up as separate IM messages.** Each `text`
  frame becomes a Feishu / Slack message line; we deliberately do
  NOT use card patching (`patch_card`) yet because the SDK shape is
  Feishu-only and Slack would diverge. Term users see the proper
  in-place stream.
- **History injected for `/agent` is lossy on `tool` entries** —
  agent-history's `role: 'tool'` entries can't carry a
  `toolCallId` round-trip, so they get dropped from the prompt
  re-injection. The agent still sees the user/assistant turns,
  which is the part that anchors context.
- **No /agent.confirm friendly alias** — IM users must paste the
  literal `agent.confirm correlationId=… approve=…` string. We can
  add a friendlier `confirm <X>` shortcut if needed.

## Deferred to post-M1 follow-up

- Migrate `services/py/quant_core/services/ta_service.py` LLM call
  to NestJS (no instruction handler currently uses `/ta`, so it's a
  pure HTTP-controller migration).
- Migrate `services/py/quant_core/services/news_sentiment_service.py`
  LLM calls to NestJS (multi-step, ~900 lines — biggest remaining
  Python LLM consumer).
- After both above land, **delete** `services/py/quant_io/llm/` +
  the prompts directory + matching unit tests + the
  `analyze_ledger` Flight op handler. (Until then, the project is
  technically running with both LLM clients alive; only the new
  callers exercise NestJS, the rest still hit Python.)
- Feishu interactive buttons + Slack interactive buttons.
- code-reviewer subagent pass (the changes meet CLAUDE.md §0
  step-4 conditions ②③: milestone wrap-up + cross-process contract
  changes).
- LangGraph migration of `chat_step` / `chat_finalize` if/when
  multi-agent or long-task-resume requirements show up (interfaces
  are already shaped to swap implementations without consumer
  churn).

## Open questions for you

1. **Feishu button activation** — do you want me to schedule the
   `card.action.trigger` integration as the first follow-up, or
   should we run with paste-back for a cycle and gather feedback
   before investing?
2. **Agent persona prompt** — the system prompt in
   `apps/api/src/modules/agent/prompts/system-prompt.ts` is a first
   draft. Tweak away; the prompt is loaded fresh per call, so a
   change is live as soon as the file is saved.
3. **Default provider for /agent** — current resolution prefers Qwen
   if its key is set (catalog order). Override with
   `AGENT_LLM_PROVIDER=moonshot` if you'd rather pin Kimi for the
   tool-loop strength.
