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

import { Inject, Injectable } from '@nestjs/common';
import {
  type AgentToolCallProposal,
  type ChatMessage,
  type ChatTokenUsage,
  type ChatTool,
  type ChatToolCall,
  type InstructionAgentDeltaPayload,
} from '@quant/shared';

import type { InstructionCtx } from '../instruction/instruction.port.js';
import { LlmService } from '../llm/llm.service.js';
import { SocketBus } from '../socket/socket-bus.service.js';
import {
  clampInt,
  formatArgs,
  parseInteger,
  sumUsage,
  truncate,
  zeroUsage,
} from './agent-helpers.js';
import { AGENT_CONFIG, type AgentConfig } from './agent.config.js';
import { AgentImDelivery } from './agent-im-delivery.js';
import { AgentPendingStore, type AgentPendingSnapshot } from './agent-pending.store.js';
import { AgentStreamFinalizer, type FrameEmitter } from './agent-stream-finalizer.js';
import { AgentToolBridge } from './agent-tool-bridge.js';
import { buildAgentSystemPrompt } from '@quant/config/prompts';
import type { AgentDeliveryTarget } from './agent.types.js';

export interface AgentRunOptions {
  readonly q: string;
  readonly history: readonly ChatMessage[];
  readonly maxToolCalls: number;
  readonly delivery: AgentDeliveryTarget;
  readonly jobId: string;
  readonly ctx: InstructionCtx;
}

/**
 * Mutable state threaded through `runLoop` / `runLoopStep` /
 * `parkAndEmitConfirm`. Kept as a single interface so the helpers can
 * share field names without `Pick<>` gymnastics.
 */
interface AgentLoopState {
  messages: ChatMessage[];
  readonly tools: readonly ChatTool[];
  usageAcc: ChatTokenUsage;
  toolCallCount: number;
  readonly maxToolCalls: number;
  readonly resumeStep: number;
  readonly delivery: AgentDeliveryTarget;
  readonly jobId: string;
  readonly ctx: InstructionCtx;
}

@Injectable()
export class AgentService {
  /** Bound `emitFrame` so the finalizer can emit through the same path
   *  without a back-reference to AgentService. */
  private readonly boundEmit: FrameEmitter = (delivery, payload) =>
    this.emitFrame(delivery, payload);

  constructor(
    @Inject(LlmService) private readonly llm: LlmService,
    @Inject(AgentToolBridge) private readonly bridge: AgentToolBridge,
    @Inject(AgentPendingStore) private readonly pending: AgentPendingStore,
    @Inject(SocketBus) private readonly sockets: SocketBus,
    @Inject(AgentImDelivery) private readonly im: AgentImDelivery,
    @Inject(AgentStreamFinalizer) private readonly finalizer: AgentStreamFinalizer,
    @Inject(AGENT_CONFIG) private readonly cfg: AgentConfig,
  ) {}

  resolveMaxToolCalls(raw: unknown): number {
    if (raw === undefined || raw === null || raw === '') return this.cfg.defaultMaxToolCalls;
    return clampInt(parseInteger(raw), this.cfg.defaultMaxToolCalls);
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
      await this.finalizer.streamFinal(
        {
          messages,
          usageAcc: snapshot.usageAcc,
          toolCallCount: snapshot.toolCallCount,
          delivery: snapshot.delivery,
          jobId: snapshot.jobId,
          ctx,
        },
        this.boundEmit,
      );
      return;
    }
    // Approved — execute the pending tool calls, then continue the loop
    // with a refreshed tool catalog (in case the registry changed mid-pause).
    await this.executeToolCalls(
      snapshot.toolCalls,
      messages,
      snapshot.delivery,
      snapshot.jobId,
      ctx,
    );
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

  private async runLoop(state: AgentLoopState): Promise<void> {
    for (let step = state.resumeStep; step < state.maxToolCalls; step++) {
      const outcome = await this.runLoopStep(state, step);
      if (outcome === 'done') return;
      // 'continue' → next iteration
    }
    // Hit the ceiling without converging — coerce a final summary.
    state.messages.push({
      role: 'user',
      content: `【已达 ${String(state.maxToolCalls)} 步工具调用上限】请基于已有结果直接给出中文最终答复，不要再发起新的工具调用。`,
    });
    await this.finalizer.streamFinal(
      {
        messages: state.messages,
        usageAcc: state.usageAcc,
        toolCallCount: state.toolCallCount,
        delivery: state.delivery,
        jobId: state.jobId,
        ctx: state.ctx,
      },
      this.boundEmit,
    );
  }

  /**
   * One iteration of the agent loop: LLM call → branch on tool-call
   * shape. Returns 'done' to stop iterating (final answer streamed,
   * confirm parked, or LLM failure emitted) or 'continue' for the next
   * step. Extracted out of `runLoop` to keep both methods under the
   * 50-LoC function cap (CLAUDE.md §1.2).
   */
  private async runLoopStep(state: AgentLoopState, step: number): Promise<'continue' | 'done'> {
    let result;
    try {
      result = await this.llm.chatWithTools(
        { messages: state.messages, tools: state.tools },
        { userId: state.ctx.userId, traceId: state.ctx.traceId, scope: 'agent' },
      );
    } catch (err) {
      await this.finalizer.emitFailure(state, err, this.boundEmit);
      return 'done';
    }
    state.usageAcc = sumUsage(state.usageAcc, result.usage);
    if (result.toolCalls.length === 0) {
      // No further tool_calls — emit the answer we already have. Re-
      // streaming was the previous behaviour but it doubled LLM cost AND
      // produced "（无回答）" when the first content was a placeholder.
      if (result.content !== null && result.content.length > 0) {
        state.messages.push({ role: 'assistant', content: result.content });
      }
      await this.finalizer.deliverFinalContent(result.content ?? '', state, this.boundEmit);
      return 'done';
    }
    // Append the assistant message carrying the tool_calls so the
    // model's transcript stays consistent on the next turn.
    state.messages.push({
      role: 'assistant',
      content: result.content ?? '',
      toolCalls: [...result.toolCalls],
    });
    const sensitive = result.toolCalls.filter((tc) => this.bridge.needsConfirmation(tc.toolId));
    if (sensitive.length > 0) {
      await this.parkAndEmitConfirm(state, step, result.toolCalls);
      return 'done';
    }
    // All read-only — execute inline and continue.
    await this.executeToolCalls(
      result.toolCalls,
      state.messages,
      state.delivery,
      state.jobId,
      state.ctx,
    );
    state.toolCallCount += result.toolCalls.length;
    return 'continue';
  }

  private async parkAndEmitConfirm(
    state: AgentLoopState,
    step: number,
    toolCalls: readonly ChatToolCall[],
  ): Promise<void> {
    const correlationId = this.pending.put({
      userId: state.ctx.userId,
      traceId: state.ctx.traceId,
      jobId: state.jobId,
      delivery: state.delivery,
      messages: state.messages,
      toolCalls,
      usageAcc: state.usageAcc,
      toolCallCount: state.toolCallCount,
      maxToolCalls: state.maxToolCalls,
      resumeStep: step,
    });
    await this.emitFrame(state.delivery, {
      kind: 'confirm',
      jobId: state.jobId,
      correlationId,
      toolCalls: toolCalls.map((tc) => this.toProposal(tc)),
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

  // streamFinal / deliverFinalContent / emitFailure delegate to
  // AgentStreamFinalizer (see ./agent-stream-finalizer.ts) — all three
  // share the same end-of-loop frame-emitting surface and were lifted
  // out together to keep this file under the 400-LoC cap.

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
    // following along sees the same stream, then hand off to
    // AgentImDelivery which buffers text + flushes on `done` and emits a
    // dedicated card on `confirm`.
    this.sockets.emitTo(delivery.userId, 'instruction.agent.delta', payload);
    await this.im.deliver(delivery, payload);
  }

  private toProposal(tc: ChatToolCall): AgentToolCallProposal {
    return {
      id: tc.toolId,
      args: tc.args,
      summary: this.bridge.summary(tc.toolId),
    };
  }
}

// Pure helpers (zeroUsage / sumUsage / clampInt / parseInteger /
// formatArgs / truncate / estimateCnyCost) moved to `agent-helpers.ts`.
