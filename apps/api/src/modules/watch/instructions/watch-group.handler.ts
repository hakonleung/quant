/**
 * `watch.group <name> <on|off>` — toggle a watch group's monitoring
 * switch without deleting it. Off pauses every task in the group;
 * on resumes them. Counters and `lastHitPrice` survive the pause.
 */

import { Inject, Injectable } from '@nestjs/common';
import { errResult, instructionId, okResult, type InstructionResult } from '@quant/shared';
import { z } from 'zod';

import type { InstructionCtx } from '../../instruction/instruction.port.js';
import { InstructionRegistrarBase } from '../../instruction/instruction.provider.js';
import { InstructionRegistry } from '../../instruction/instruction.registry.js';
import type { InstructionSpec } from '../../instruction/instruction.types.js';
import { WatchService } from '../watch.service.js';

const argsSchema = z
  .object({
    name: z.string().min(1).describe('Watch group name'),
    state: z
      .enum(['on', 'off', 'pause', 'resume'])
      .describe('on|resume to enable, off|pause to disable'),
  })
  .strict();
type Args = z.infer<typeof argsSchema>;

@Injectable()
export class WatchGroupInstructionHandler extends InstructionRegistrarBase<Args> {
  readonly spec: InstructionSpec<Args> = {
    id: instructionId('watch.group'),
    summary: 'Toggle a watch group on/off without deleting it. watch.group <name> <on|off>',
    summaryCn: '开关一个自选盯盘 group 的通知（保留任务）',
    group: 'watch',
    argsSchema,
    positional: ['name', 'state'],
    imAliases: ['暂停自选', '恢复自选', '盯盘开关'],
    examples: ['watch.group us off', 'watch.group t0 on'],
  };

  constructor(
    @Inject(InstructionRegistry) registry: InstructionRegistry,
    @Inject(WatchService) private readonly watch: WatchService,
  ) {
    super(registry);
  }

  async execute(args: Args, ctx: InstructionCtx): Promise<InstructionResult> {
    const enabled = args.state === 'on' || args.state === 'resume';
    try {
      const group = await this.watch.patchGroup(ctx.userId, args.name, { enabled });
      return okResult(
        `watch group ${group.name} ${group.enabled ? 'resumed' : 'paused'} (${String(args.state)})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errResult('not-found', msg);
    }
  }
}
