/**
 * `watch` instruction. v1 supports `watch list` (and the dotted alias
 * `watch.list`) — list every registered watch task with its group,
 * status, and last hit. `add` / `remove` are deferred until the
 * argument surface settles (group cascade rules, market dispatch);
 * users still go through `POST /api/watch/tasks` for now.
 */

import { Inject, Injectable } from '@nestjs/common';
import { instructionId, okResult, type InstructionResult } from '@quant/shared';
import { z } from 'zod';

import type { InstructionCtx } from '../../instruction/instruction.port.js';
import { InstructionRegistrarBase } from '../../instruction/instruction.provider.js';
import { InstructionRegistry } from '../../instruction/instruction.registry.js';
import type { InstructionSpec } from '../../instruction/instruction.types.js';
import { WatchService } from '../watch.service.js';

const argsSchema = z
  .object({
    sub: z.enum(['list']).default('list'),
  })
  .strict();
type Args = z.infer<typeof argsSchema>;

@Injectable()
export class WatchInstructionHandler extends InstructionRegistrarBase<Args> {
  readonly spec: InstructionSpec<Args> = {
    id: instructionId('watch'),
    summary: 'Inspect watch tasks. v1 only supports `watch list`.',
    summaryCn: '预警任务列表',
    group: 'watch',
    argsSchema,
    positional: ['sub'],
    aliases: [instructionId('watch.list')],
    imAliases: ['自选'],
  };

  constructor(
    @Inject(InstructionRegistry) registry: InstructionRegistry,
    @Inject(WatchService) private readonly watch: WatchService,
  ) {
    super(registry);
  }

  async execute(_args: Args, ctx: InstructionCtx): Promise<InstructionResult> {
    // v1 only ships `list`; the spec's zod enum guarantees `args.sub === 'list'` at runtime,
    // so no extra branch is needed. Add subcommands by widening the enum + the switch below.
    const tasks = await this.watch.list(ctx.userId);
    if (tasks.length === 0) return okResult('no watch tasks');
    const lines = tasks.map((t) => {
      const status = t.enabled ? 'on' : 'off';
      const remaining = t.remaining === null ? '∞' : String(t.remaining);
      return `  ${t.market}:${t.code.padEnd(8)} ${t.name.padEnd(8)} grp=${t.groupName.padEnd(10)} ${status} hits=${String(t.hitCount)} rem=${remaining}`;
    });
    return okResult(`watch tasks (${String(tasks.length)}):\n${lines.join('\n')}`);
  }
}
