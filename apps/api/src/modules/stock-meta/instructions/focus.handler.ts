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
import { StockMetaService } from '../stock-meta.service.js';

const argsSchema = z
  .object({
    code: z.string().regex(/^\d{6}$/u, 'code must be 6 digits'),
  })
  .strict();

type Args = z.infer<typeof argsSchema>;

@Injectable()
export class FocusInstructionHandler extends InstructionRegistrarBase<Args> {
  readonly spec: InstructionSpec<Args> = {
    id: instructionId('focus'),
    summary: 'Validate an A-share code and report its name + industry.',
    summaryCn: '查询个股名称与所属行业',
    group: 'market',
    argsSchema,
    positional: ['code'],
  };

  constructor(
    @Inject(InstructionRegistry) registry: InstructionRegistry,
    @Inject(StockMetaService) private readonly stockMeta: StockMetaService,
  ) {
    super(registry);
  }

  async execute(args: Args, ctx: InstructionCtx): Promise<InstructionResult> {
    try {
      const meta = await this.stockMeta.get(args.code, ctx.traceId);
      const industry = meta.industries.length > 0 ? meta.industries : '-';
      return okResult(`focus = ${meta.code} ${meta.name} (${industry})`);
    } catch (err) {
      if (err instanceof QuantError && err.code === 'STOCK_NOT_FOUND') {
        return errResult('not-found', `stock ${args.code} not found`);
      }
      throw err;
    }
  }
}
