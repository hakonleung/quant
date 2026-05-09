import { Inject, Injectable } from '@nestjs/common';
import { instructionId, okResult, type InstructionResult } from '@quant/shared';
import { z } from 'zod';

import type { InstructionCtx } from '../../instruction/instruction.port.js';
import { InstructionRegistrarBase } from '../../instruction/instruction.provider.js';
import { InstructionRegistry } from '../../instruction/instruction.registry.js';
import type { InstructionSpec } from '../../instruction/instruction.types.js';
import { SectorsStore } from '../sectors.store.js';

const argsSchema = z.object({}).strict();
type Args = z.infer<typeof argsSchema>;

@Injectable()
export class SectorInstructionHandler extends InstructionRegistrarBase<Args> {
  readonly spec: InstructionSpec<Args> = {
    id: instructionId('sector'),
    summary: 'List user-defined sectors with their member counts.',
    summaryCn: '查看自定义板块及成分数',
    group: 'market',
    argsSchema,
    imAliases: ['板块'],
  };

  constructor(
    @Inject(InstructionRegistry) registry: InstructionRegistry,
    @Inject(SectorsStore) private readonly sectors: SectorsStore,
  ) {
    super(registry);
  }

  execute(_args: Args, _ctx: InstructionCtx): Promise<InstructionResult> {
    const list = this.sectors.list();
    if (list.length === 0) return Promise.resolve(okResult('no sectors defined'));
    const lines = list.map(
      (s) => `  ${s.id.padEnd(20)}  ${s.name.padEnd(16)}  ${String(s.codes.length)} codes`,
    );
    return Promise.resolve(okResult(`sectors (${String(list.length)}):\n${lines.join('\n')}`));
  }
}
