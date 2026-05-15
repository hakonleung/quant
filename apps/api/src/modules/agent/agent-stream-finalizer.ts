/**
 * Streaming-finalisation layer for the `/agent` flow.
 *
 * Owns the three "end-of-loop" code paths:
 *
 *   - {@link streamFinal} — call `LlmService.chatStreamFinalize` to
 *     produce the final answer chunk-by-chunk, emitting `text` frames
 *     for each delta and one `done` frame at the end.
 *   - {@link deliverFinalContent} — bypass the streaming call and emit
 *     an already-produced answer as a single `text` + `done` (used when
 *     the loop's last LLM step returned content with no tool_calls).
 *   - {@link emitFailure} — surface an LLM-call error to the user as a
 *     `text` + `done` pair so the IM card / socket stream still closes.
 *
 * Extracted out of `agent.service.ts` to keep the loop file under the
 * 400-LoC cap (CLAUDE.md §1.2). The frame emitter is injected as a
 * callback so this layer doesn't need a back-reference to the loop /
 * IM delivery layer.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ChatMessage, ChatTokenUsage, InstructionAgentDeltaPayload } from '@quant/shared';

import { CLOCK, type Clock } from '../../common/clock.js';
import type { InstructionCtx } from '../instruction/instruction.port.js';
import { LlmService } from '../llm/llm.service.js';
import { estimateCnyCost, sumUsage, zeroUsage } from './agent-helpers.js';
import { AgentHistoryStore } from './agent-history.store.js';
import type { AgentDeliveryTarget } from './agent.types.js';

const STREAM_FAILURE_TEXT = '\n\n（LLM 流式生成失败，请稍后重试。）';

export type FrameEmitter = (
  delivery: AgentDeliveryTarget,
  payload: InstructionAgentDeltaPayload,
) => Promise<void>;

interface FinalArgs {
  readonly messages: readonly ChatMessage[];
  readonly usageAcc: ChatTokenUsage;
  readonly toolCallCount: number;
  readonly delivery: AgentDeliveryTarget;
  readonly jobId: string;
  readonly ctx: InstructionCtx;
}

@Injectable()
export class AgentStreamFinalizer {
  private readonly logger = new Logger(AgentStreamFinalizer.name);

  constructor(
    @Inject(LlmService) private readonly llm: LlmService,
    @Inject(AgentHistoryStore) private readonly history: AgentHistoryStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Single-shot delivery of an already-produced final answer (no extra
   * LLM call). Mirrors the post-stream tail of {@link streamFinal} so
   * IM and socket consumers see identical envelopes regardless of which
   * code path produced the answer.
   */
  async deliverFinalContent(
    content: string,
    state: Omit<FinalArgs, 'messages'>,
    emit: FrameEmitter,
  ): Promise<void> {
    if (content.length > 0) {
      await emit(state.delivery, {
        kind: 'text',
        jobId: state.jobId,
        chunk: content,
        done: true,
      });
    }
    await emit(state.delivery, {
      kind: 'done',
      jobId: state.jobId,
      tokenUsage: state.usageAcc,
      cnyCost: estimateCnyCost(state.usageAcc),
      toolCallCount: state.toolCallCount,
    });
    if (state.delivery.kind === 'im' && content.length > 0) {
      this.history.append(state.delivery.userId, state.delivery.channel, {
        role: 'assistant',
        content,
        ts: this.clock.now().toISOString(),
      });
    }
  }

  async streamFinal(args: FinalArgs, emit: FrameEmitter): Promise<void> {
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
          await emit(args.delivery, {
            kind: 'text',
            jobId: args.jobId,
            chunk: chunk.delta,
            done: chunk.done,
          });
        }
      }
    } catch (err) {
      this.logger.warn(`agent_stream_failed trace_id=${args.ctx.traceId} err=${String(err)}`);
      await emit(args.delivery, {
        kind: 'text',
        jobId: args.jobId,
        chunk: STREAM_FAILURE_TEXT,
        done: true,
      });
      assembled += STREAM_FAILURE_TEXT;
    }
    const totalUsage = sumUsage(args.usageAcc, lastUsage ?? zeroUsage());
    await emit(args.delivery, {
      kind: 'done',
      jobId: args.jobId,
      tokenUsage: totalUsage,
      cnyCost: estimateCnyCost(totalUsage),
      toolCallCount: args.toolCallCount,
    });
    // IM history capture — term keeps its own scrollback authoritatively.
    if (args.delivery.kind === 'im' && assembled.length > 0) {
      this.history.append(args.delivery.userId, args.delivery.channel, {
        role: 'assistant',
        content: assembled,
        ts: this.clock.now().toISOString(),
      });
    }
  }

  async emitFailure(
    state: {
      readonly delivery: AgentDeliveryTarget;
      readonly jobId: string;
      readonly ctx: InstructionCtx;
    },
    err: unknown,
    emit: FrameEmitter,
  ): Promise<void> {
    const msg = err instanceof Error ? err.message : String(err);
    this.logger.warn(`agent_loop_step_failed trace_id=${state.ctx.traceId} err=${msg}`);
    await emit(state.delivery, {
      kind: 'text',
      jobId: state.jobId,
      chunk: `（LLM 调用失败：${msg}）`,
      done: true,
    });
    await emit(state.delivery, {
      kind: 'done',
      jobId: state.jobId,
      tokenUsage: zeroUsage(),
      cnyCost: 0,
      toolCallCount: 0,
    });
  }
}
