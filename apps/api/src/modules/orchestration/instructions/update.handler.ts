/**
 * `/update` — manually fire the unified daily scan. Same code path as
 * the 16:00 BJT cron and the `POST /api/orchestration/scan` HTTP
 * endpoint: meta + kline enqueue, settlement tail runs blacklist +
 * dynamic sectors. Coalesces with any in-flight scan.
 *
 * Returns immediately with the trace id; clients watch the socket
 * `queue.snapshot` topic for progress.
 */

import { Inject, Injectable } from '@nestjs/common';
import { instructionId, okResult, type InstructionResult } from '@quant/shared';
import type { z } from 'zod';
import { UpdateArgsSchema } from '@quant/shared';

import type { InstructionCtx } from '../../instruction/instruction.port.js';
import { InstructionRegistrarBase } from '../../instruction/instruction.provider.js';
import { InstructionRegistry } from '../../instruction/instruction.registry.js';
import type { InstructionSpec } from '../../instruction/instruction.types.js';
import { CronOrchestrator } from '../cron.orchestrator.js';

const argsSchema = UpdateArgsSchema;
type Args = z.infer<typeof argsSchema>;

@Injectable()
export class UpdateInstructionHandler extends InstructionRegistrarBase<Args> {
  readonly spec: InstructionSpec<Args> = {
    id: instructionId('update'),
    summary: 'Fire the unified daily scan (meta + kline + blacklist + sectors).',
    summaryCn: '手动触发每日全量扫描',
    group: 'system',
    argsSchema,
    imAliases: ['更新'],
    destructive: true,
  };

  constructor(
    @Inject(InstructionRegistry) registry: InstructionRegistry,
    @Inject(CronOrchestrator) private readonly cron: CronOrchestrator,
  ) {
    super(registry);
  }

  execute(_args: Args, _ctx: InstructionCtx): Promise<InstructionResult> {
    const accepted = this.cron.fireScan();
    const msg = accepted.started
      ? `scan started: traceId=${accepted.traceId}`
      : `scan already in flight (coalesced): traceId=${accepted.traceId}`;
    return Promise.resolve(okResult(msg));
  }
}
