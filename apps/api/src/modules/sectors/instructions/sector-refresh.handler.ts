/**
 * `/sector.refresh <id>` — re-run a dynamic sector's screen and persist.
 * Any user (owner or not) may trigger; the codes/lastScreenedAt update
 * is visible to everyone who can see the sector.
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
export class SectorRefreshInstructionHandler extends InstructionRegistrarBase<Args> {
  readonly spec: InstructionSpec<Args> = {
    id: instructionId('sector.refresh'),
    summary: 'Re-run a dynamic sector and persist the result.',
    summaryCn: '刷新动态板块(任何用户均可触发)',
    group: 'market',
    argsSchema,
    positional: ['id'],
    examples: ['sector.refresh s1'],
  };

  constructor(
    @Inject(InstructionRegistry) registry: InstructionRegistry,
    @Inject(SectorsService) private readonly sectors: SectorsService,
  ) {
    super(registry);
  }

  async execute(args: Args, ctx: InstructionCtx): Promise<InstructionResult> {
    try {
      await this.sectors.refreshDynamic(ctx.userId, args.id, ctx.traceId);
      return okResult('done');
    } catch (err) {
      if (err instanceof QuantError) {
        if (err.code === 'NOT_FOUND') return errResult('not-found', err.message);
        if (err.code === 'INVALID_ARGUMENT') return errResult('validation', err.message);
      }
      throw err;
    }
  }
}
