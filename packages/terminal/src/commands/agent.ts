/**
 * `agent` — natural-language total entry point.
 *
 *   agent <prompt...>          → opens a paid-confirm widget; on YES,
 *                                 spawns the BE /agent loop and streams
 *                                 the answer into a fresh OutputEntry.
 *   agent --confirm <prompt>   → skips the confirm widget; used by the
 *                                 widget's own commit (so re-running the
 *                                 line via cmd-history doesn't keep
 *                                 firing the widget on every retry).
 *
 * The command relies on three host-injected pieces from `CommandCtx`:
 *   - `actions.invokeBeInstruction(...)` to fire the BE socket call,
 *   - `actions.subscribeAgentDelta(jobId, cb)` to get incremental frames,
 *   - `dispatchEvent(event)` to push streamOpen/Chunk/Close into the
 *     engine while the loop runs.
 *
 * Mock / unit-test runners are missing those handles; the command then
 * surfaces a polite "agent unavailable in this environment" error.
 */

import type { AgentDeltaFrame } from '../actions/types.js';
import { confirmPrompt } from '../widgets/confirm-prompt.js';
import {
  commandResolution,
  interactive,
  noopResolution,
  textErr,
  textOk,
} from '../widgets/helpers.js';
import type { CommandCtx, CommandSpec } from '../registry.js';
import type { Event } from '../engine/state.js';

const HISTORY_DEPTH = 5;

export const agentCommand: CommandSpec = {
  name: 'agent',
  aliases: ['助手'],
  summary:
    'Natural-language assistant — translate intent into tool calls and stream a final answer.',
  async run(argv, ctx) {
    const positional = argv.positional.join(' ').trim();
    const isConfirmed = readFlag(argv.flags, 'confirm') ?? readFlag(argv.flags, 'y');
    const qFlag = argv.flags['q'];
    const prompt = (typeof qFlag === 'string' ? qFlag : positional).trim();
    if (prompt.length === 0) {
      return textErr('agent 需要一句话提示词。用法：agent <你想问什么>');
    }
    if (!isConfirmed) {
      return interactive(buildPaidConfirm(prompt));
    }
    return await launch(ctx, prompt);
  },
};

function buildPaidConfirm(prompt: string): ReturnType<typeof confirmPrompt> {
  const truncated = prompt.length > 80 ? `${prompt.slice(0, 80)}…` : prompt;
  return confirmPrompt({
    title: '确认调用 /agent ?',
    body:
      '将触发外部付费 LLM + 多步指令调用。' + `\n\n问题：${truncated}` + '\n\nY 继续 / N 取消。',
    onYes: () => commandResolution(`agent confirm=1 q=${quote(prompt)}`),
    onNo: () => noopResolution,
  });
}

async function launch(
  ctx: CommandCtx,
  prompt: string,
): Promise<{ kind: 'text'; status: 'ok' | 'err'; tail: { body: string } }> {
  if (
    ctx.actions.invokeBeInstruction === undefined ||
    ctx.actions.subscribeAgentDelta === undefined ||
    ctx.dispatchEvent === undefined
  ) {
    return textErr(
      'agent 需要后端 socket 桥接（invokeBeInstruction + subscribeAgentDelta + dispatchEvent），当前 runner 不支持。',
    );
  }
  const dispatch = ctx.dispatchEvent;
  const subscribe = ctx.actions.subscribeAgentDelta;

  let invocation;
  try {
    invocation = await ctx.actions.invokeBeInstruction('agent', {
      q: prompt,
      confirm: true,
      context: collectHistory(ctx),
    });
  } catch (err) {
    return textErr(err instanceof Error ? err.message : String(err));
  }

  const { jobId, text, ok } = invocation;
  if (!ok) {
    return textErr(text);
  }

  const streamId = `agent-${jobId}`;
  dispatch({
    kind: 'streamOpen',
    streamId,
    status: 'info',
    initialBody: `▶ /agent jobId=${jobId.slice(0, 8)}…`,
  });

  let unsubscribe: (() => void) | null = null;
  unsubscribe = subscribe(jobId, (frame: AgentDeltaFrame) => {
    handleFrame(frame, streamId, dispatch, () => {
      unsubscribe?.();
      unsubscribe = null;
    });
  });
  // Tear down on user cancel signal too — the host's AbortController
  // fires when the user hits Ctrl+C.
  ctx.signal.addEventListener(
    'abort',
    () => {
      unsubscribe?.();
      unsubscribe = null;
      dispatch({
        kind: 'streamClose',
        streamId,
        status: 'info',
        footer: '\n（已取消订阅，BE loop 仍在后台运行）',
      });
    },
    { once: true },
  );

  return textOk(`▶ /agent loop started — jobId=${jobId}`);
}

function handleFrame(
  frame: AgentDeltaFrame,
  streamId: string,
  dispatch: (event: Event) => void,
  finish: () => void,
): void {
  switch (frame.kind) {
    case 'step':
      dispatch({ kind: 'streamStepLog', streamId, line: frame.message });
      return;
    case 'tool_result': {
      const head = frame.ok ? '✓' : '✗';
      const lines = frame.summary
        .split('\n')
        .map((l) => `   ${l}`)
        .join('\n');
      dispatch({
        kind: 'streamStepLog',
        streamId,
        line: `${head} ${frame.toolId}\n${lines}`,
      });
      return;
    }
    case 'confirm': {
      const lines = frame.toolCalls
        .map((p, i) => `  ${String(i + 1)}. /${p.id} ${formatArgs(p.args)} — ${p.summary}`)
        .join('\n');
      dispatch({
        kind: 'streamStepLog',
        streamId,
        line:
          '\n[需要确认] Agent 申请执行：\n' +
          lines +
          `\n回复以批准： agent.confirm correlationId=${frame.correlationId} approve=1` +
          `\n或取消：    agent.confirm correlationId=${frame.correlationId} approve=0`,
      });
      return;
    }
    case 'text':
      if (frame.chunk.length > 0) {
        dispatch({ kind: 'streamChunk', streamId, delta: frame.chunk });
      }
      return;
    case 'done':
      dispatch({
        kind: 'streamClose',
        streamId,
        status: frame.toolCallCount > 0 ? 'ok' : 'info',
        footer:
          `\n—— ${String(frame.toolCallCount)} 轮工具调用，` +
          `token: in=${String(frame.tokenUsage.input)} ` +
          `out=${String(frame.tokenUsage.output)} ` +
          `total=${String(frame.tokenUsage.total)}，` +
          `¥ ${frame.cnyCost.toFixed(4)}`,
      });
      finish();
      return;
    default:
      return;
  }
}

function readFlag(flags: Readonly<Record<string, string | boolean>>, key: string): boolean | null {
  const v = flags[key];
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v;
  if (v === '' || v === '1' || v.toLowerCase() === 'true' || v === 'y') return true;
  return false;
}

function quote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function formatArgs(args: Readonly<Record<string, unknown>>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue;
    parts.push(`${k}=${stringify(v)}`);
  }
  return parts.join(' ');
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return /\s/.test(v) ? `"${v}"` : v;
  return String(v);
}

/**
 * Pull the last few prompt + output entries out of the engine state so
 * the BE loop has rough context. We don't have direct access to
 * TerminalState here — the actions runner exposes a hook through
 * stores when the host wires it up; we expect the live runner to
 * provide a `chatHistory` shim. Falls back to no context.
 */
function collectHistory(ctx: CommandCtx): readonly {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly ts: string;
}[] {
  const stores = ctx.stores as { readonly chatHistory?: () => readonly unknown[] };
  const fn = stores.chatHistory;
  if (typeof fn !== 'function') return [];
  const raw = fn();
  if (!Array.isArray(raw)) return [];
  const out: { role: 'user' | 'assistant'; content: string; ts: string }[] = [];
  for (const entry of raw.slice(-HISTORY_DEPTH)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as { role?: unknown; content?: unknown; ts?: unknown };
    if (typeof e.content !== 'string' || typeof e.ts !== 'string') continue;
    const role = e.role === 'assistant' ? 'assistant' : 'user';
    out.push({ role, content: e.content, ts: e.ts });
  }
  return out;
}
