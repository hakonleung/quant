/**
 * FE `/agent` cell — paid LLM tool-use loop.
 *
 * Streaming side-effect lives in the handler: after the typed BE
 * invoke returns `{ jobId, maxToolCalls }`, the handler opens a stream
 * entry via `ctx.dispatchEvent` and subscribes to
 * `ctx.actions.subscribeAgentDelta` to drain frames in the background.
 * The cell handler resolves immediately after subscription set-up; the
 * stream content fans in through the dispatched engine events. Renderer
 * just prints the ack line.
 *
 * Confirm flow mirrors analyze / screen: without `args.confirm`, the
 * handler throws `confirm-required` and the renderer surfaces a
 * paid-confirm widget that re-dispatches with `confirm=1`.
 */

import {
  InstructionDispatchError,
  type InstructionCell,
  type ResultOf,
} from '@quant/shared';
import type { AgentDeltaFrame, Event as TerminalEvent } from '@quant/terminal';
import {
  confirmPrompt,
  interactive,
  noopResolution,
  textErr,
  textOk,
} from '@quant/terminal';

import type { FeCtx, FeEnv } from '../fe-types.js';

type AgentResult = ResultOf<'agent'>;

const HISTORY_DEPTH = 5;

export function buildAgentCell(): InstructionCell<FeEnv, 'agent'> {
  return {
    async handler(args, ctx): Promise<AgentResult> {
      if (args.confirm !== true) {
        throw new InstructionDispatchError(
          'confirm-required',
          JSON.stringify({ q: args.q }),
        );
      }
      const subscribe = ctx.actions.subscribeAgentDelta;
      const dispatch = ctx.dispatchEvent;
      if (subscribe === undefined || dispatch === undefined) {
        throw new InstructionDispatchError(
          'handler',
          'agent 需要后端 socket 桥接（subscribeAgentDelta + dispatchEvent），当前 runner 不支持。',
        );
      }

      const env = await ctx.api.invoke(
        'agent',
        {
          q: args.q,
          confirm: true,
          context: args.context !== undefined ? [...args.context] : [...collectHistory(ctx)],
        },
        { signal: ctx.signal },
      );
      if (!env.ok) throw new Error(env.error.message);

      const { jobId } = env.data;
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

      return env.data;
    },
    renderer(envelope) {
      if (!envelope.ok) {
        if (envelope.error.code === 'confirm-required') {
          const p = safeParse(envelope.error.message);
          const truncated = p.q.length > 80 ? `${p.q.slice(0, 80)}…` : p.q;
          return interactive(
            confirmPrompt({
              title: '确认调用 /agent ?',
              body:
                '将触发外部付费 LLM + 多步指令调用。' +
                `\n\n问题：${truncated}` +
                '\n\nY 继续 / N 取消。',
              onYes: () => ({
                kind: 'command',
                line: `agent confirm=1 q=${quote(p.q)}`,
              }),
              onNo: () => noopResolution,
            }),
          );
        }
        if (envelope.error.code === 'handler' && envelope.error.message.startsWith('agent 需要后端')) {
          return textErr(envelope.error.message);
        }
        return textErr(envelope.error.message);
      }
      return textOk(`▶ /agent loop started — jobId=${envelope.data.jobId}`);
    },
  };
}

function safeParse(raw: string): { q: string } {
  try {
    const p = JSON.parse(raw) as { q?: unknown };
    return { q: typeof p.q === 'string' ? p.q : '' };
  } catch {
    return { q: '' };
  }
}

function quote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function handleFrame(
  frame: AgentDeltaFrame,
  streamId: string,
  dispatch: (event: TerminalEvent) => void,
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
 * Pull the last few prompt + output entries from the engine state via
 * the host-injected `stores.chatHistory` shim. Falls back to no context
 * when the host doesn't provide it (mock runner / unit tests).
 */
function collectHistory(ctx: FeCtx): readonly {
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
