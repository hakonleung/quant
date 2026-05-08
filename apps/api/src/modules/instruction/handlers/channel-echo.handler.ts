import { Inject, Injectable } from '@nestjs/common';
import { instructionId, okResult, type InstructionResult } from '@quant/shared';
import { z } from 'zod';

import type { InstructionCtx } from '../instruction.port.js';
import { InstructionRegistrarBase } from '../instruction.provider.js';
import { InstructionRegistry } from '../instruction.registry.js';
import type { InstructionSpec } from '../instruction.types.js';

const argsSchema = z.record(z.string()).default({});
type Args = z.infer<typeof argsSchema>;

@Injectable()
export class ChannelEchoHandler extends InstructionRegistrarBase<Args> {
  readonly spec: InstructionSpec<Args> = {
    id: instructionId('channel.echo'),
    summary: 'Echo args back through the same IM channel (debug).',
    argsSchema,
  };

  constructor(@Inject(InstructionRegistry) registry: InstructionRegistry) {
    super(registry);
  }

  execute(args: Args, ctx: InstructionCtx): Promise<InstructionResult> {
    const body = Object.entries(args)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    return Promise.resolve(
      okResult(
        `echo source=${ctx.source} channel=${ctx.channelId ?? '-'} sender=${ctx.sender ?? '-'}${body.length > 0 ? ` ${body}` : ''}`,
      ),
    );
  }
}
