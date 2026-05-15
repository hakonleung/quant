import { Inject, Injectable } from '@nestjs/common';
import {
  SectorArgsSchema,
  instructionId,
  okResult,
  okResultWithMeta,
  type InstructionResult,
} from '@quant/shared';
import type { z } from 'zod';

import type { InstructionCtx } from '../../instruction/instruction.port.js';
import { InstructionRegistrarBase } from '../../instruction/instruction.provider.js';
import { InstructionRegistry } from '../../instruction/instruction.registry.js';
import type { InstructionSpec } from '../../instruction/instruction.types.js';
import { SectorsService } from '../sectors.service.js';

const argsSchema = SectorArgsSchema;
type Args = z.infer<typeof argsSchema>;

@Injectable()
export class SectorInstructionHandler extends InstructionRegistrarBase<Args> {
  readonly spec: InstructionSpec<Args> = {
    id: instructionId('sector'),
    summary: 'List sectors visible to the caller (own + published).',
    summaryCn: '查看自定义板块及成分数(含已发布的公共板块)',
    group: 'market',
    argsSchema,
    imAliases: ['板块'],
    examples: ['sector'],
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
    const rows = list.map((s) => ({
      pub: s.published ? '✓' : '',
      id: s.id,
      name: s.name,
      count: String(s.codes.length),
      by: s.createdBy === ctx.userId ? 'me' : s.createdBy,
    }));
    const text = `sectors (${String(list.length)}):\n${list
      .map(
        (s) =>
          `  ${s.published ? '[PUB]' : '     '} ${s.id.padEnd(20)}  ${s.name.padEnd(16)}  ${String(s.codes.length).padStart(4)}  by ${s.createdBy === ctx.userId ? 'me' : s.createdBy}`,
      )
      .join('\n')}`;
    return Promise.resolve(
      okResultWithMeta(text, {
        tableSections: [
          {
            columns: [
              // Feishu v2 table only accepts widths in [80px, 600px] — narrower
              // labels still take the 80px floor.
              { name: 'pub', displayName: 'pub', horizontalAlign: 'center', width: '80px' },
              { name: 'id', displayName: 'id', horizontalAlign: 'left', width: '90px' },
              { name: 'name', displayName: 'name', horizontalAlign: 'left', width: '160px' },
              { name: 'count', displayName: 'n', horizontalAlign: 'right', width: '80px' },
              { name: 'by', displayName: 'by', horizontalAlign: 'left', width: '120px' },
            ],
            rows,
          },
        ],
        tablesSubheader: `sectors (${String(list.length)})`,
      }),
    );
  }
}
