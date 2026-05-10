/**
 * `/sector.publish <id>` and `/sector.unpublish <id>` — owner-only.
 *
 * Sync handlers — the underlying mutation is one file write, well under
 * the IM ack budget. Confirmation UX is handled at the surface (terminal
 * `confirmPrompt`, web `useConfirm`, IM card); the instruction itself
 * does the unconditional toggle.
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

abstract class SectorPublishToggleBase extends InstructionRegistrarBase<Args> {
  protected abstract readonly publish: boolean;

  constructor(
    @Inject(InstructionRegistry) registry: InstructionRegistry,
    @Inject(SectorsService) protected readonly sectors: SectorsService,
  ) {
    super(registry);
  }

  async execute(args: Args, ctx: InstructionCtx): Promise<InstructionResult> {
    try {
      await this.sectors.setPublished(ctx.userId, args.id, this.publish);
      return okResult('done');
    } catch (err) {
      if (err instanceof QuantError) {
        if (err.code === 'FORBIDDEN') return errResult('forbidden', err.message);
        if (err.code === 'NOT_FOUND') return errResult('not-found', err.message);
      }
      throw err;
    }
  }
}

@Injectable()
export class SectorPublishInstructionHandler extends SectorPublishToggleBase {
  protected readonly publish = true;
  readonly spec: InstructionSpec<Args> = {
    id: instructionId('sector.publish'),
    summary: 'Publish a sector you own.',
    summaryCn: '发布板块(仅创建者可操作)',
    group: 'market',
    argsSchema,
    positional: ['id'],
    destructive: true,
    imAliases: ['发布板块', '公开板块'],
    examples: ['sector.publish s1'],
  };
}

@Injectable()
export class SectorUnpublishInstructionHandler extends SectorPublishToggleBase {
  protected readonly publish = false;
  readonly spec: InstructionSpec<Args> = {
    id: instructionId('sector.unpublish'),
    summary: 'Unpublish a sector you own.',
    summaryCn: '取消发布板块(仅创建者可操作)',
    group: 'market',
    argsSchema,
    positional: ['id'],
    destructive: true,
    imAliases: ['取消发布板块', '下架板块'],
    examples: ['sector.unpublish s1'],
  };
}
