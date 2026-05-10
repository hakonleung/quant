/**
 * `/sector rm <id>` — owner-only delete. Routed via the shared parser's
 * dotted-id resolution so `sector rm s1` reaches `sector.rm`.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  errResult,
  instructionId,
  okResult,
  QuantError,
  type InstructionResult,
} from '@quant/shared';
import { z } from 'zod';

import type { InstructionCtx } from '../../instruction/instruction.port.js';
import { InstructionRegistrarBase } from '../../instruction/instruction.provider.js';
import { InstructionRegistry } from '../../instruction/instruction.registry.js';
import type { InstructionSpec } from '../../instruction/instruction.types.js';
import { SectorsService } from '../sectors.service.js';

const argsSchema = z.object({ id: z.string().min(1) }).strict();
type Args = z.infer<typeof argsSchema>;

@Injectable()
export class SectorRmInstructionHandler extends InstructionRegistrarBase<Args> {
  readonly spec: InstructionSpec<Args> = {
    id: instructionId('sector.rm'),
    summary: 'Delete a sector you own.',
    summaryCn: '删除板块（仅创建者可操作）',
    group: 'market',
    argsSchema,
    positional: ['id'],
    destructive: true,
    examples: ['sector.rm s1'],
  };

  constructor(
    @Inject(InstructionRegistry) registry: InstructionRegistry,
    @Inject(SectorsService) private readonly sectors: SectorsService,
  ) {
    super(registry);
  }

  async execute(args: Args, ctx: InstructionCtx): Promise<InstructionResult> {
    try {
      await this.sectors.remove(ctx.userId, args.id);
      return okResult('done');
    } catch (err) {
      if (err instanceof QuantError) {
        if (err.code === 'NOT_FOUND') return errResult('not-found', err.message);
        if (err.code === 'FORBIDDEN') return errResult('forbidden', err.message);
      }
      throw err;
    }
  }
}
