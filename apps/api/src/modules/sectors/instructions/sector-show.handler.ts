/**
 * `/sector show <idOrName>` — print one sector's basic info + first N codes.
 * Accepts the FE terminal's subcommand syntax (`sector show s1`) via the
 * shared parser's dotted-id resolution.
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

const PREVIEW_CODES = 20;

const argsSchema = z.object({ id: z.string().min(1) }).strict();
type Args = z.infer<typeof argsSchema>;

@Injectable()
export class SectorShowInstructionHandler extends InstructionRegistrarBase<Args> {
  readonly spec: InstructionSpec<Args> = {
    id: instructionId('sector.show'),
    summary: 'Show one sector by id or name (head of code list).',
    summaryCn: '查看某个板块的基础信息和前 20 个成分代码',
    group: 'market',
    argsSchema,
    positional: ['id'],
  };

  constructor(
    @Inject(InstructionRegistry) registry: InstructionRegistry,
    @Inject(SectorsService) private readonly sectors: SectorsService,
  ) {
    super(registry);
  }

  execute(args: Args, ctx: InstructionCtx): Promise<InstructionResult> {
    try {
      const sector = this.sectors.resolveVisible(ctx.userId, args.id);
      const head = sector.codes.slice(0, PREVIEW_CODES);
      const tail =
        sector.codes.length > head.length
          ? ` (+${String(sector.codes.length - head.length)} more)`
          : '';
      const lines = [
        `${sector.id}  ${sector.name}  [${sector.kind}]  by ${sector.createdBy === ctx.userId ? 'me' : sector.createdBy}${sector.published ? '  [PUB]' : ''}`,
        `count=${String(sector.count)}  chgPct=${sector.chgPct === null ? '—' : String(sector.chgPct)}`,
        `codes: ${head.join(', ')}${tail}`,
      ];
      return Promise.resolve(okResult(lines.join('\n')));
    } catch (err) {
      if (err instanceof QuantError && err.code === 'NOT_FOUND') {
        return Promise.resolve(errResult('not-found', err.message));
      }
      throw err;
    }
  }
}
