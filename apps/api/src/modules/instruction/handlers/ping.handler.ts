import { Inject, Injectable } from '@nestjs/common';
import { instructionId, okResult, type InstructionResult } from '@quant/shared';
import { z } from 'zod';

import { INSTRUCTION_CONFIG, type InstructionConfig } from '../instruction.config.js';
import type { InstructionCtx } from '../instruction.port.js';
import { InstructionRegistrarBase } from '../instruction.provider.js';
import { InstructionRegistry } from '../instruction.registry.js';
import type { InstructionSpec } from '../instruction.types.js';

const argsSchema = z.record(z.string()).default({});
type Args = z.infer<typeof argsSchema>;

@Injectable()
export class PingHandler extends InstructionRegistrarBase<Args> {
  readonly spec: InstructionSpec<Args> = {
    id: instructionId('ping'),
    summary: 'Round-trip latency probe; echoes args + traceId. (debug)',
    summaryCn: '延迟探测，回显参数和 traceId（调试）',
    group: 'system',
    argsSchema,
  };

  constructor(
    @Inject(InstructionRegistry) registry: InstructionRegistry,
    @Inject(INSTRUCTION_CONFIG) private readonly cfg: InstructionConfig,
  ) {
    super(registry);
  }

  protected override shouldRegister(): boolean {
    return this.cfg.debugInstructionsEnabled;
  }

  execute(args: Args, ctx: InstructionCtx): Promise<InstructionResult> {
    const echo = Object.entries(args)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    const tail = echo.length > 0 ? ` ${echo}` : '';
    return Promise.resolve(okResult(`pong${tail} traceId=${ctx.traceId}`));
  }
}
