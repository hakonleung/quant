/**
 * `/agent.confirm` — continuation handler for a paused agent loop.
 *
 * The user-facing confirm card / widget calls this with:
 *   - `correlationId` from the matching `instruction.agent.delta` frame
 *   - `approve=true` to run the parked tool calls (the loop resumes
 *     and may pause again on the next sensitive batch)
 *   - `approve=false` to cancel; the loop summarises with the
 *     "user cancelled" hint and emits `done`.
 *
 * Mode is `sync` so the caller gets immediate acknowledgement; the
 * loop continues detached.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  errResult,
  instructionId,
  okResult,
  type InstructionResult,
} from '@quant/shared';

import type { InstructionCtx } from '../../instruction/instruction.port.js';
import { InstructionRegistrarBase } from '../../instruction/instruction.provider.js';
import { InstructionRegistry } from '../../instruction/instruction.registry.js';
import type { InstructionSpec } from '../../instruction/instruction.types.js';
import { AgentConfirmArgsSchema, type AgentConfirmArgs } from '../dto/agent.dto.js';
import { AgentPendingStore } from '../agent-pending.store.js';
import { AgentService } from '../agent.service.js';

@Injectable()
export class AgentConfirmInstructionHandler extends InstructionRegistrarBase<AgentConfirmArgs> {
  readonly spec: InstructionSpec<AgentConfirmArgs> = {
    id: instructionId('agent.confirm'),
    summary: 'Resume a paused /agent loop after user approval.',
    summaryCn: '确认 /agent 工具调用，恢复执行（内部用）',
    group: 'system',
    argsSchema: AgentConfirmArgsSchema,
    mode: 'sync',
  };

  constructor(
    @Inject(InstructionRegistry) registry: InstructionRegistry,
    @Inject(AgentService) private readonly agent: AgentService,
    @Inject(AgentPendingStore) private readonly pending: AgentPendingStore,
  ) {
    super(registry);
  }

  async execute(args: AgentConfirmArgs, ctx: InstructionCtx): Promise<InstructionResult> {
    const snapshot = this.pending.take(args.correlationId);
    if (snapshot === null) {
      return errResult(
        'not-found',
        `agent confirmation expired or unknown: ${args.correlationId}`,
      );
    }
    if (snapshot.userId !== ctx.userId) {
      // Should not happen with proper auth, but defend in depth.
      return errResult('forbidden', 'agent confirmation does not belong to this user');
    }
    void this.agent.resume(snapshot, args.approve, ctx).catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error(
        `/agent.confirm resume failed correlationId=${args.correlationId} err=${String(err)}`,
      );
    });
    return okResult(
      `▶ /agent.confirm correlationId=${args.correlationId} approve=${String(args.approve)} — 续派中。`,
    );
  }
}
