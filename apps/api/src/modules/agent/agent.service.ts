/**
 * The `/agent` multi-step loop.
 *
 *   for step in 1..MAX:
 *     ChatStepResult = LlmService.chatWithTools(messages, tools)
 *     if no tool_calls → stream the final answer + emit `done` → return
 *     for each tool_call:
 *       if costsCredits / destructive → park snapshot, emit `confirm`,
 *           return early (resumed by `/agent.confirm`)
 *       else execute via InstructionExecutor, append `role:'tool'` msg,
 *           emit `step` + `tool_result` frames
 *
 *   When MAX is exhausted → force one final streaming summarisation so
 *   the user still gets a coherent answer.
 *
 * Run twice in two flavours:
 *   - `runFresh(...)` from the `/agent` handler (first call).
 *   - `resume(snapshot, approvedToolCallIds)` from `/agent.confirm`
 *     (continuation after user approval).
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  type AgentToolCallProposal,
  type ChannelId,
  type ChatMessage,
  type ChatTokenUsage,
  type ChatTool,
  type ChatToolCall,
  type InstructionAgentDeltaPayload,
} from '@quant/shared';

import { CLOCK, type Clock } from '../../common/clock.js';
import type { InstructionCtx } from '../instruction/instruction.port.js';
import { LlmService } from '../llm/llm.service.js';
import { priceCallCny } from '../llm/providers.js';
import { LLM_PROVIDERS } from '../llm/providers.js';
import { SocketBus } from '../socket/socket-bus.service.js';
import { ChannelService } from '../channel/channel.service.js';
import { AgentHistoryStore } from './agent-history.store.js';
import {
  AgentPendingStore,
  type AgentPendingSnapshot,
} from './agent-pending.store.js';
import { AgentToolBridge } from './agent-tool-bridge.js';
import { buildAgentSystemPrompt } from './prompts/system-prompt.js';
import type { AgentDeliveryTarget } from './agent.types.js';

const DEFAULT_MAX_TOOL_CALLS = 5;
const HARD_MAX_TOOL_CALLS = 10;
const MIN_MAX_TOOL_CALLS = 1;
const STREAM_FAILURE_TEXT = '\n\n（LLM 流式生成失败，请稍后重试。）';

export interface AgentRunOptions {
  readonly q: string;
  readonly history: readonly ChatMessage[];
  readonly maxToolCalls: number;
  readonly delivery: AgentDeliveryTarget;
  readonly jobId: string;
  readonly ctx: InstructionCtx;
}

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    @Inject(LlmService) private readonly llm: LlmService,
    @Inject(AgentToolBridge) private readonly bridge: AgentToolBridge,
    @Inject(AgentHistoryStore) private readonly history: AgentHistoryStore,
    @Inject(AgentPendingStore) private readonly pending: AgentPendingStore,
    @Inject(SocketBus) private readonly sockets: SocketBus,
    @Inject(ChannelService) private readonly channels: ChannelService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  resolveMaxToolCalls(raw: unknown): number {
    const envRaw = process.env['AGENT_MAX_TOOL_CALLS'];
    const fallback = clampInt(parseInteger(envRaw), DEFAULT_MAX_TOOL_CALLS);
    if (raw === undefined || raw === null || raw === '') return fallback;
    return clampInt(parseInteger(raw), fallback);
  }

  /** Top-level entry from the `/agent` handler. */
  async runFresh(opts: AgentRunOptions): Promise<void> {
    const tools = this.bridge.exposeForAgent();
    const messages: ChatMessage[] = [
      { role: 'system', content: buildAgentSystemPrompt(tools) },
      ...opts.history,
      { role: 'user', content: opts.q },
    ];
    await this.runLoop({
      messages,
      tools,
      usageAcc: zeroUsage(),
      toolCallCount: 0,
      maxToolCalls: opts.maxToolCalls,
      resumeStep: 0,
      delivery: opts.delivery,
      jobId: opts.jobId,
      ctx: opts.ctx,
    });
  }

  /** Continuation entry when `/agent.confirm` lifts a parked snapshot. */
  async resume(
    snapshot: AgentPendingSnapshot,
    approve: boolean,
    ctx: InstructionCtx,
  ): Promise<void> {
    const messages: ChatMessage[] = [...snapshot.messages];
    if (!approve) {
      messages.push({
        role: 'user',
        content: '【用户已取消上述工具调用】请基于已有信息直接给出中文最终答复。',
      });
      await this.streamFinal({
        messages,
        usageAcc: snapshot.usageAcc,
        toolCallCount: snapshot.toolCallCount,
        delivery: snapshot.delivery,
        jobId: snapshot.jobId,
        ctx,
      });
      return;
    }
    // Approved — execute the pending tool calls, then continue the loop
    // with a refreshed tool catalog (in case the registry changed mid-pause).
    await this.executeToolCalls(snapshot.toolCalls, messages, snapshot.delivery, snapshot.jobId, ctx);
    await this.runLoop({
      messages,
      tools: this.bridge.exposeForAgent(),
      usageAcc: snapshot.usageAcc,
      toolCallCount: snapshot.toolCallCount + snapshot.toolCalls.length,
      maxToolCalls: snapshot.maxToolCalls,
      resumeStep: snapshot.resumeStep + 1,
      delivery: snapshot.delivery,
      jobId: snapshot.jobId,
      ctx,
    });
  }

  // -------------------------------------------------------------------------
  // core loop
  // -------------------------------------------------------------------------

  private async runLoop(state: {
    messages: ChatMessage[];
    tools: readonly ChatTool[];
    usageAcc: ChatTokenUsage;
    toolCallCount: number;
    maxToolCalls: number;
    resumeStep: number;
    delivery: AgentDeliveryTarget;
    jobId: string;
    ctx: InstructionCtx;
  }): Promise<void> {
    for (let step = state.resumeStep; step < state.maxToolCalls; step++) {
      let result;
      try {
        result = await this.llm.chatWithTools(
          { messages: state.messages, tools: state.tools },
          { userId: state.ctx.userId, traceId: state.ctx.traceId, scope: 'agent' },
        );
      } catch (err) {
        await this.emitFailure(state, err);
        return;
      }
      state.usageAcc = sumUsage(state.usageAcc, result.usage);
      if (result.toolCalls.length === 0) {
        // Final answer — re-stream so the user sees it land progressively.
        if (result.content !== null && result.content.length > 0) {
          state.messages.push({ role: 'assistant', content: result.content });
        }
        await this.streamFinal({
          messages: state.messages,
          usageAcc: state.usageAcc,
          toolCallCount: state.toolCallCount,
          delivery: state.delivery,
          jobId: state.jobId,
          ctx: state.ctx,
        });
        return;
      }

      // Has tool calls — split into "needs confirm" vs "auto-run".
      const sensitive = result.toolCalls.filter((tc) => this.bridge.needsConfirmation(tc.toolId));
      // Append the assistant message carrying the tool_calls so the
      // model's transcript stays consistent on the next turn.
      state.messages.push({
        role: 'assistant',
        content: result.content ?? '',
        toolCalls: [...result.toolCalls],
      });
      if (sensitive.length > 0) {
        const correlationId = this.pending.put({
          userId: state.ctx.userId,
          traceId: state.ctx.traceId,
          jobId: state.jobId,
          delivery: state.delivery,
          messages: state.messages,
          toolCalls: result.toolCalls,
          usageAcc: state.usageAcc,
          toolCallCount: state.toolCallCount,
          maxToolCalls: state.maxToolCalls,
          resumeStep: step,
        });
        await this.emitFrame(state.delivery, {
          kind: 'confirm',
          jobId: state.jobId,
          correlationId,
          toolCalls: result.toolCalls.map((tc) => this.toProposal(tc)),
        });
        return;
      }

      // All read-only — execute them inline.
      await this.executeToolCalls(
        result.toolCalls,
        state.messages,
        state.delivery,
        state.jobId,
        state.ctx,
      );
      state.toolCallCount += result.toolCalls.length;
    }

    // Hit the ceiling without converging — coerce a final summary.
    state.messages.push({
      role: 'user',
      content: `【已达 ${String(state.maxToolCalls)} 步工具调用上限】请基于已有结果直接给出中文最终答复，不要再发起新的工具调用。`,
    });
    await this.streamFinal({
      messages: state.messages,
      usageAcc: state.usageAcc,
      toolCallCount: state.toolCallCount,
      delivery: state.delivery,
      jobId: state.jobId,
      ctx: state.ctx,
    });
  }

  // -------------------------------------------------------------------------
  // inline tool execution
  // -------------------------------------------------------------------------

  private async executeToolCalls(
    toolCalls: readonly ChatToolCall[],
    messages: ChatMessage[],
    delivery: AgentDeliveryTarget,
    jobId: string,
    ctx: InstructionCtx,
  ): Promise<void> {
    for (const tc of toolCalls) {
      await this.emitFrame(delivery, {
        kind: 'step',
        jobId,
        message: `▶ /${tc.toolId} ${formatArgs(tc.args)}`,
      });
      const result = await this.bridge.executeToolCall(tc, ctx);
      const summary = this.bridge.toolMessageContent(result);
      messages.push({ role: 'tool', toolCallId: tc.id, content: summary });
      await this.emitFrame(delivery, {
        kind: 'tool_result',
        jobId,
        toolId: tc.toolId,
        ok: result.ok,
        summary: truncate(summary, 600),
      });
    }
  }

  // -------------------------------------------------------------------------
  // streaming finalisation
  // -------------------------------------------------------------------------

  private async streamFinal(args: {
    messages: ChatMessage[];
    usageAcc: ChatTokenUsage;
    toolCallCount: number;
    delivery: AgentDeliveryTarget;
    jobId: string;
    ctx: InstructionCtx;
  }): Promise<void> {
    let lastUsage: ChatTokenUsage | undefined;
    let assembled = '';
    try {
      for await (const chunk of this.llm.chatStreamFinalize(
        { messages: args.messages },
        { userId: args.ctx.userId, traceId: args.ctx.traceId, scope: 'agent' },
      )) {
        if (chunk.usage) lastUsage = chunk.usage;
        if (chunk.delta.length > 0) {
          assembled += chunk.delta;
          await this.emitFrame(args.delivery, {
            kind: 'text',
            jobId: args.jobId,
            chunk: chunk.delta,
            done: chunk.done,
          });
        }
      }
    } catch (err) {
      this.logger.warn(
        `agent_stream_failed trace_id=${args.ctx.traceId} err=${String(err)}`,
      );
      await this.emitFrame(args.delivery, {
        kind: 'text',
        jobId: args.jobId,
        chunk: STREAM_FAILURE_TEXT,
        done: true,
      });
      assembled += STREAM_FAILURE_TEXT;
    }

    const totalUsage = sumUsage(args.usageAcc, lastUsage ?? zeroUsage());
    const cnyCost = estimateCnyCost(totalUsage);
    await this.emitFrame(args.delivery, {
      kind: 'done',
      jobId: args.jobId,
      tokenUsage: totalUsage,
      cnyCost,
      toolCallCount: args.toolCallCount,
    });

    // Capture the assistant's final text in the IM history slot so the
    // next turn sees it. Skipping for terminal because term keeps its own
    // scrollback authoritatively.
    if (args.delivery.kind === 'im' && assembled.length > 0) {
      this.history.append(args.delivery.userId, args.delivery.channel, {
        role: 'assistant',
        content: assembled,
        ts: this.clock.now().toISOString(),
      });
    }
  }

  private async emitFailure(
    state: { delivery: AgentDeliveryTarget; jobId: string; ctx: InstructionCtx },
    err: unknown,
  ): Promise<void> {
    const msg = err instanceof Error ? err.message : String(err);
    this.logger.warn(`agent_loop_step_failed trace_id=${state.ctx.traceId} err=${msg}`);
    await this.emitFrame(state.delivery, {
      kind: 'text',
      jobId: state.jobId,
      chunk: `（LLM 调用失败：${msg}）`,
      done: true,
    });
    await this.emitFrame(state.delivery, {
      kind: 'done',
      jobId: state.jobId,
      tokenUsage: zeroUsage(),
      cnyCost: 0,
      toolCallCount: 0,
    });
  }

  // -------------------------------------------------------------------------
  // delivery
  // -------------------------------------------------------------------------

  private async emitFrame(
    delivery: AgentDeliveryTarget,
    payload: InstructionAgentDeltaPayload,
  ): Promise<void> {
    if (delivery.kind === 'socket') {
      this.sockets.emitTo(delivery.userId, 'instruction.agent.delta', payload);
      return;
    }
    // IM delivery: also push a socket frame so a logged-in web user
    // following along sees the same stream, then translate per-frame
    // into a channel.send call so the IM gets the same content.
    this.sockets.emitTo(delivery.userId, 'instruction.agent.delta', payload);
    await this.imDeliver(delivery, payload);
  }

  private async imDeliver(
    delivery: { readonly channel: ChannelId; readonly target: string; readonly userId: string },
    payload: InstructionAgentDeltaPayload,
  ): Promise<void> {
    // The mid-loop tool-proposal confirm gets a dedicated card kind so
    // the Feishu adapter renders an interactive card with the
    // copy-paste /agent.confirm command.
    if (payload.kind === 'confirm') {
      const text = payload.toolCalls
        .map((p, i) => `  ${String(i + 1)}. /${p.id} ${formatArgs(p.args)} — ${p.summary}`)
        .join('\n');
      try {
        await this.channels.send(
          delivery.channel,
          {
            text,
            kind: 'agent.tool_proposal',
            target: delivery.target,
            meta: { correlationId: payload.correlationId, jobId: payload.jobId },
          },
          { traceId: 'agent', source: 'system' },
        );
      } catch (err) {
        this.logger.warn(
          `agent_im_confirm_failed channel=${delivery.channel} err=${String(err)}`,
        );
      }
      return;
    }

    const text = renderFrameForIm(payload);
    if (text === null) return;
    try {
      await this.channels.send(
        delivery.channel,
        {
          text,
          kind: 'instruction.agent.delta',
          target: delivery.target,
          meta: { kind: payload.kind, jobId: payload.jobId },
        },
        { traceId: 'agent', source: 'system' },
      );
    } catch (err) {
      this.logger.warn(
        `agent_im_send_failed channel=${delivery.channel} err=${String(err)}`,
      );
    }
  }

  private toProposal(tc: ChatToolCall): AgentToolCallProposal {
    return {
      id: tc.toolId,
      args: tc.args,
      summary: this.bridge.summary(tc.toolId),
    };
  }
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

function zeroUsage(): ChatTokenUsage {
  return { input: 0, output: 0, total: 0 };
}

function sumUsage(a: ChatTokenUsage, b: ChatTokenUsage): ChatTokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    total: a.total + b.total,
  };
}

function clampInt(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  if (value < MIN_MAX_TOOL_CALLS) return MIN_MAX_TOOL_CALLS;
  if (value > HARD_MAX_TOOL_CALLS) return HARD_MAX_TOOL_CALLS;
  return Math.trunc(value);
}

function parseInteger(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string' && raw.length > 0) {
    const v = Number(raw);
    return Number.isFinite(v) ? v : NaN;
  }
  return NaN;
}

function formatArgs(args: Readonly<Record<string, unknown>>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && /\s/.test(v)) {
      parts.push(`${k}="${v}"`);
    } else {
      parts.push(`${k}=${String(v)}`);
    }
  }
  return parts.join(' ');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

/**
 * Cost estimate using the agent's own provider row's pricing — close
 * enough for display purposes; the per-call recorder ledger has the
 * exact figures.
 */
function estimateCnyCost(usage: ChatTokenUsage): number {
  // Pick the first catalog row with a key in env — same heuristic as
  // the LlmService default resolution. Falls back to "0" if no
  // provider has been configured (dev box without keys).
  for (const row of LLM_PROVIDERS) {
    const key = process.env[row.apiKeyEnv];
    if (typeof key === 'string' && key.length > 0) {
      return priceCallCny(row, usage);
    }
  }
  return 0;
}

function renderFrameForIm(payload: InstructionAgentDeltaPayload): string | null {
  switch (payload.kind) {
    case 'step':
      return payload.message;
    case 'tool_result':
      return `(${payload.ok ? 'ok' : 'err'}) ${payload.toolId}\n${payload.summary}`;
    case 'confirm':
      return `请确认以下工具调用（在终端 / 飞书卡片回复 confirm=${payload.correlationId}）：\n${payload.toolCalls
        .map((p, i) => `  ${String(i + 1)}. /${p.id} ${formatArgs(p.args)} — ${p.summary}`)
        .join('\n')}`;
    case 'text':
      // Streaming text in IM is too chatty; we emit only the final
      // assembled answer via the `done` frame's preceding `text` frames
      // already pushed. v1: send each text chunk as-is. Slack/Feishu
      // adapters merge chunks into a single message in the patch path
      // (v2 will use card patching; v1 keeps it simple).
      return payload.chunk.length > 0 ? payload.chunk : null;
    case 'done':
      return `—— ${String(payload.toolCallCount)} 轮工具调用，token: in=${String(payload.tokenUsage.input)} out=${String(payload.tokenUsage.output)} total=${String(payload.tokenUsage.total)}，¥ ${payload.cnyCost.toFixed(4)}`;
    default:
      return null;
  }
}
