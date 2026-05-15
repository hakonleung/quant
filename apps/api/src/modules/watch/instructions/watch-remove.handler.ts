/**
 * `watch.remove <wid>` — remove a watch task by its w-index.
 *
 * `wid` accepts both `w1` and bare `1`; the leading `w` is stripped before
 * parsing so IM users can type either form naturally.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  WatchRemoveArgsSchema,
  errResult,
  instructionId,
  okResult,
  type InstructionResult,
} from '@quant/shared';
import type { z } from 'zod';

import type { InstructionCtx } from '../../instruction/instruction.port.js';
import { InstructionRegistrarBase } from '../../instruction/instruction.provider.js';
import { InstructionRegistry } from '../../instruction/instruction.registry.js';
import type { InstructionSpec } from '../../instruction/instruction.types.js';
import { WatchTaskStore } from '../watch-task.store.js';

const argsSchema = WatchRemoveArgsSchema;
type Args = z.infer<typeof argsSchema>;

@Injectable()
export class WatchRemoveInstructionHandler extends InstructionRegistrarBase<Args> {
  readonly spec: InstructionSpec<Args> = {
    id: instructionId('watch.remove'),
    summary: 'Remove a watch task by its w-index. watch.remove w1',
    summaryCn: '删除自选股票预警任务',
    group: 'watch',
    argsSchema,
    positional: ['id'],
    imAliases: ['删除自选', '移除自选', '删除预警'],
    examples: ['watch.remove w1', 'watch.remove 2'],
  };

  constructor(
    @Inject(InstructionRegistry) registry: InstructionRegistry,
    @Inject(WatchTaskStore) private readonly taskStore: WatchTaskStore,
  ) {
    super(registry);
  }

  async execute(args: Args, ctx: InstructionCtx): Promise<InstructionResult> {
    const raw = args.id.replace(/^w/iu, '');
    const idx = parseInt(raw, 10);
    if (!Number.isInteger(idx) || idx < 1) {
      return errResult(
        'validation',
        `invalid watch id "${args.id}"; expected w1, w2, … or bare number`,
      );
    }

    const removed = await this.taskStore.deleteByIdx(ctx.userId, idx);
    if (removed === undefined) {
      return errResult('not-found', `watch task w${String(idx)} not found`);
    }

    void removed;
    return okResult('done');
  }
}
