/**
 * `/agent` instruction — natural-language total entry point.
 *
 * Behaviour:
 *   - sync mode: when `confirm` is missing/false the handler returns
 *     immediately with an "operator confirmation required" message;
 *     the caller (term widget / IM listener) flips `confirm=true`
 *     after the user accepts.
 *   - when confirmed, the handler kicks off the multi-step loop in
 *     `AgentService` and returns an "agent started" line. The actual
 *     output streams via `instruction.agent.delta` socket frames.
 *
 * The instruction itself is therefore neither sync-result-bearing nor
 * BullMQ-async — it acts as a stateful trigger. We keep it `mode: 'sync'`
 * because the trigger reply is small and immediate; the long-running
 * loop runs detached on the same Node process (post-stream).
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  errResult,
  instructionId,
  okResult,
  type ChatMessage,
  type InstructionResult,
} from '@quant/shared';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';

import type { InstructionCtx } from '../../instruction/instruction.port.js';
import { InstructionRegistrarBase } from '../../instruction/instruction.provider.js';
import { InstructionRegistry } from '../../instruction/instruction.registry.js';
import type { InstructionSpec } from '../../instruction/instruction.types.js';
import { AgentArgsSchema, type AgentArgs } from '../dto/agent.dto.js';
import { AgentHistoryStore } from '../agent-history.store.js';
import { AgentService } from '../agent.service.js';
import type { AgentDeliveryTarget } from '../agent.types.js';

@Injectable()
export class AgentInstructionHandler extends InstructionRegistrarBase<AgentArgs> {
  readonly spec: InstructionSpec<AgentArgs> = {
    id: instructionId('agent'),
    summary:
      'Natural-language entry point — translates intent into tool calls and streams a final answer.',
    summaryCn: '自然语言入口，AI 自动调用对应指令并生成中文综述',
    group: 'system',
    argsSchema: AgentArgsSchema,
    positional: ['q'],
    imAliases: ['助手'],
    mode: 'sync',
    costsCredits: true,
  };

  constructor(
    @Inject(InstructionRegistry) registry: InstructionRegistry,
    @Inject(AgentService) private readonly agent: AgentService,
    @Inject(AgentHistoryStore) private readonly history: AgentHistoryStore,
  ) {
    super(registry);
  }

  async execute(args: AgentArgs, ctx: InstructionCtx): Promise<InstructionResult> {
    if (args.confirm !== true) {
      // Hand the IM / term layer enough context to render a confirm card
      // and re-dispatch /agent with confirm=1 on approval. The literal
      // text of error.message is JSON so the renderer can decode it.
      return errResult('confirm-required', JSON.stringify({ q: args.q, kind: 'agent.paid' }));
    }
    const delivery = pickDelivery(ctx);
    if (delivery === null) {
      return errResult('forbidden', '/agent requires socket or IM context');
    }
    const jobId = randomUUID();
    const maxToolCalls = this.agent.resolveMaxToolCalls(args.maxToolCalls);
    const history = this.collectHistory(args, ctx);
    // Run the loop detached so we return the trigger ack immediately.
    void this.agent
      .runFresh({ q: args.q, history, maxToolCalls, delivery, jobId, ctx })
      .catch((err: unknown) => {
        // Errors inside the loop already emit `text`+`done` frames; this
        // catch is the last line of defence.
        // eslint-disable-next-line no-console
        console.error(`/agent run failed jobId=${jobId} err=${String(err)}`);
      });
    return okResult(
      `▶ /agent 启动 jobId=${jobId} maxSteps=${String(maxToolCalls)} — 通过 instruction.agent.delta 流接收增量。`,
    );
  }

  private collectHistory(args: AgentArgs, ctx: InstructionCtx): readonly ChatMessage[] {
    const messages: ChatMessage[] = [];
    const push = (role: 'user' | 'assistant' | 'tool', content: string): void => {
      // Drop `tool` history entries — re-injecting them would need the
      // original toolCallId, which we don't carry in the history feed.
      // The user-visible flow already includes the tool result via the
      // assistant turn that quoted it, so this keeps semantics intact.
      if (role === 'tool') return;
      messages.push({ role, content });
    };
    if (args.context !== undefined && args.context.length > 0) {
      for (const entry of args.context) push(entry.role, entry.content);
      return messages;
    }
    if (ctx.source === 'im' && ctx.channelId !== undefined) {
      const recent = this.history.recent(ctx.userId, ctx.channelId, 10);
      for (const entry of recent) push(entry.role, entry.content);
    }
    return messages;
  }
}

function pickDelivery(ctx: InstructionCtx): AgentDeliveryTarget | null {
  if (ctx.source === 'socket' || ctx.source === 'http') {
    return { kind: 'socket', userId: ctx.userId };
  }
  if (
    ctx.source === 'im' &&
    ctx.channelId !== undefined &&
    typeof ctx.target === 'string' &&
    ctx.target.length > 0
  ) {
    return { kind: 'im', channel: ctx.channelId, target: ctx.target, userId: ctx.userId };
  }
  return null;
}

// Suppress unused-import: z is referenced via AgentArgsSchema.
void z;
