/**
 * Per-job IM delivery layer for the `/agent` flow.
 *
 * The agent loop emits frame-grained `InstructionAgentDeltaPayload`s
 * (text chunks, step / tool_result, confirm, done). For socket consumers
 * each frame is forwarded verbatim; for IM (Slack / Feishu) we collapse
 * them into one consolidated card per job:
 *
 *   - `step` / `tool_result` → suppressed
 *   - `text` → buffered in `imTextBuffer[jobId]`
 *   - `done` → flush the buffer + token-usage footer in one
 *     `channels.send` call
 *   - `confirm` → emit a dedicated `agent.tool_proposal` card
 *
 * Extracted out of `agent.service.ts` to keep that file under the
 * 400-LoC cap (CLAUDE.md §1.2). The buffer state lives here; a single
 * `AgentImDelivery` instance is created per `AgentService` provider.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ChannelId, InstructionAgentDeltaPayload } from '@quant/shared';

import { ChannelService } from '../channel/channel.service.js';
import { formatArgs } from './agent-helpers.js';

export interface ImDeliveryTarget {
  readonly channel: ChannelId;
  readonly target: string;
  readonly userId: string;
}

@Injectable()
export class AgentImDelivery {
  private readonly logger = new Logger(AgentImDelivery.name);
  private readonly buffer = new Map<string, string>();

  constructor(@Inject(ChannelService) private readonly channels: ChannelService) {}

  async deliver(target: ImDeliveryTarget, payload: InstructionAgentDeltaPayload): Promise<void> {
    if (payload.kind === 'confirm') {
      await this.deliverConfirm(target, payload);
      return;
    }
    // step / tool_result frames are suppressed for IM — users get one
    // consolidated message, not a stream of deltas.
    if (payload.kind === 'step' || payload.kind === 'tool_result') return;
    if (payload.kind === 'text') {
      const prev = this.buffer.get(payload.jobId) ?? '';
      this.buffer.set(payload.jobId, prev + payload.chunk);
      return;
    }
    if (payload.kind === 'done') {
      await this.deliverDone(target, payload);
    }
  }

  private async deliverConfirm(
    target: ImDeliveryTarget,
    payload: Extract<InstructionAgentDeltaPayload, { kind: 'confirm' }>,
  ): Promise<void> {
    const text = payload.toolCalls
      .map((p, i) => `  ${String(i + 1)}. /${p.id} ${formatArgs(p.args)} — ${p.summary}`)
      .join('\n');
    try {
      await this.channels.send(
        target.channel,
        {
          text,
          kind: 'agent.tool_proposal',
          target: target.target,
          meta: { correlationId: payload.correlationId, jobId: payload.jobId },
        },
        { traceId: 'agent', source: 'system' },
      );
    } catch (err) {
      this.logger.warn(`agent_im_confirm_failed channel=${target.channel} err=${String(err)}`);
    }
  }

  private async deliverDone(
    target: ImDeliveryTarget,
    payload: Extract<InstructionAgentDeltaPayload, { kind: 'done' }>,
  ): Promise<void> {
    const body = this.buffer.get(payload.jobId) ?? '';
    this.buffer.delete(payload.jobId);
    const footer = `\n\n—— ${String(payload.toolCallCount)} 轮工具，¥ ${payload.cnyCost.toFixed(4)} | in=${String(payload.tokenUsage.input)} out=${String(payload.tokenUsage.output)}`;
    const text = (body.trim().length > 0 ? body : '（无回答）') + footer;
    try {
      await this.channels.send(
        target.channel,
        {
          text,
          kind: 'instruction.agent.delta',
          target: target.target,
          meta: { kind: 'done', jobId: payload.jobId },
        },
        { traceId: 'agent', source: 'system' },
      );
    } catch (err) {
      this.logger.warn(`agent_im_send_failed channel=${target.channel} err=${String(err)}`);
    }
  }
}

