/**
 * `/update` — manually trigger a refresh of a cached dataset.
 *
 *   /update target=blacklist   (default)
 *
 * v1 only knows `blacklist`; the enum widens as more modules grow a
 * thin `refresh(traceId)` method (kline / meta would each need their
 * own service surface). Sync because A-share blacklist takes ~2-5s.
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
import { BlacklistService } from '../blacklist.service.js';

const argsSchema = z
  .object({
    target: z.enum(['blacklist']).default('blacklist'),
  })
  .strict();

type Args = z.infer<typeof argsSchema>;

@Injectable()
export class UpdateInstructionHandler extends InstructionRegistrarBase<Args> {
  readonly spec: InstructionSpec<Args> = {
    id: instructionId('update'),
    summary: 'Refresh a cached dataset. v1 only supports `target=blacklist`.',
    summaryCn: '手动刷新缓存数据集',
    group: 'system',
    argsSchema,
    positional: ['target'],
    imAliases: ['更新'],
  };

  constructor(
    @Inject(InstructionRegistry) registry: InstructionRegistry,
    @Inject(BlacklistService) private readonly blacklist: BlacklistService,
  ) {
    super(registry);
  }

  // The zod enum currently has a single value (`blacklist`); widen the
  // schema + add a switch here when `meta` / `kline` come online.
  async execute(_args: Args, ctx: InstructionCtx): Promise<InstructionResult> {
    try {
      const snap = await this.blacklist.refresh(ctx.traceId);
      return okResult(
        `updated blacklist: size=${String(snap.codes.length)} asof=${snap.asof} universe=${String(snap.universeSize)}`,
      );
    } catch (err) {
      if (err instanceof QuantError) return errResult('handler', err.message);
      throw err;
    }
  }
}
