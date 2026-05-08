/**
 * Replaces the v0 `ChannelCommandService.handle({ kind: 'channel.send' })`
 * branch. Registered as `channel.send` so socket clients can send manual
 * IM messages without inventing a parallel HTTP route.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  ChannelIdSchema,
  errResult,
  instructionId,
  okResult,
  type InstructionResult,
} from '@quant/shared';
import { z } from 'zod';

import type { InstructionCtx } from '../../instruction/instruction.port.js';
import { InstructionRegistrarBase } from '../../instruction/instruction.provider.js';
import { InstructionRegistry } from '../../instruction/instruction.registry.js';
import type { InstructionSpec } from '../../instruction/instruction.types.js';
import { ChannelService } from '../channel.service.js';

const argsSchema = z
  .object({
    channel: ChannelIdSchema,
    text: z.string().min(1).max(16000),
    target: z.string().min(1).max(256).optional(),
    title: z.string().max(280).optional(),
  })
  .strict();

type Args = z.infer<typeof argsSchema>;

@Injectable()
export class ChannelSendHandler extends InstructionRegistrarBase<Args> {
  readonly spec: InstructionSpec<Args> = {
    id: instructionId('channel.send'),
    summary: 'Send a manual outbound message to slack/feishu.',
    argsSchema,
    positional: ['channel', 'text'],
  };

  constructor(
    @Inject(InstructionRegistry) registry: InstructionRegistry,
    @Inject(ChannelService) private readonly channels: ChannelService,
  ) {
    super(registry);
  }

  async execute(args: Args, ctx: InstructionCtx): Promise<InstructionResult> {
    const res = await this.channels.send(
      args.channel,
      {
        text: args.text,
        kind: 'manual',
        ...(args.target !== undefined ? { target: args.target } : {}),
        ...(args.title !== undefined ? { title: args.title } : {}),
      },
      { traceId: ctx.traceId, source: 'manual' },
    );
    if (res.accepted.length === 0) {
      return errResult('handler', `no enabled channel matched ${args.channel}`);
    }
    return okResult(
      `queued to ${res.accepted.join(',')} (${String(res.activityIds.length)} job(s))`,
    );
  }
}
