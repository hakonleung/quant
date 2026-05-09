import { Inject, Injectable } from '@nestjs/common';
import { instructionId, okResult, type InstructionResult } from '@quant/shared';
import { z } from 'zod';

import type { InstructionCtx } from '../../instruction/instruction.port.js';
import { InstructionRegistrarBase } from '../../instruction/instruction.provider.js';
import { InstructionRegistry } from '../../instruction/instruction.registry.js';
import type { InstructionSpec } from '../../instruction/instruction.types.js';
import { SectorsService } from '../sectors.service.js';

const argsSchema = z.object({}).strict();
type Args = z.infer<typeof argsSchema>;

@Injectable()
export class SectorInstructionHandler extends InstructionRegistrarBase<Args> {
  readonly spec: InstructionSpec<Args> = {
    id: instructionId('sector'),
    summary: 'List sectors visible to the caller (own + published).',
    summaryCn: '查看自定义板块及成分数(含已发布的公共板块)',
    group: 'market',
    argsSchema,
    aliases: [instructionId('sector.list')],
    imAliases: ['板块'],
  };

  constructor(
    @Inject(InstructionRegistry) registry: InstructionRegistry,
    @Inject(SectorsService) private readonly sectors: SectorsService,
  ) {
    super(registry);
  }

  execute(_args: Args, ctx: InstructionCtx): Promise<InstructionResult> {
    const list = this.sectors.listVisibleTo(ctx.userId);
    if (list.length === 0) return Promise.resolve(okResult('no sectors visible'));
    const lines = list.map((s) => {
      const ownerTag = s.createdBy === ctx.userId ? 'me' : s.createdBy;
      const pubTag = s.published ? '[PUB]' : '     ';
      return `  ${pubTag} ${s.id.padEnd(20)}  ${s.name.padEnd(16)}  ${String(s.codes.length).padStart(4)}  by ${ownerTag}`;
    });
    return Promise.resolve(okResult(`sectors (${String(list.length)}):\n${lines.join('\n')}`));
  }
}
