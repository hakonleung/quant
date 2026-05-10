/**
 * `watch.add <code> [market=a] group=<name>` — add a stock to the watch list.
 *
 * The group must already exist (created via `POST /api/watch/groups`).
 * Returns the assigned w-index so the user can reference it later with
 * `watch.remove`.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  errResult,
  instructionId,
  isValidWatchCode,
  okResult,
  QuantError,
  type InstructionResult,
} from '@quant/shared';
import { z } from 'zod';

import type { InstructionCtx } from '../../instruction/instruction.port.js';
import { InstructionRegistrarBase } from '../../instruction/instruction.provider.js';
import { InstructionRegistry } from '../../instruction/instruction.registry.js';
import type { InstructionSpec } from '../../instruction/instruction.types.js';
import type { WatchTaskCreate } from '../dto/watch.dto.js';
import { WatchService } from '../watch.service.js';

const argsSchema = z
  .object({
    code: z.string().min(1).describe('Stock code, e.g. 600519 for A-shares'),
    market: z.enum(['a', 'hk', 'us']).default('a').describe('Market: a | hk | us'),
    group: z.string().min(1).describe('Watch group name (must already exist)'),
    name: z.string().optional().describe('Human-readable label (defaults to stock name)'),
  })
  .strict();
type Args = z.infer<typeof argsSchema>;

@Injectable()
export class WatchAddInstructionHandler extends InstructionRegistrarBase<Args> {
  readonly spec: InstructionSpec<Args> = {
    id: instructionId('watch.add'),
    summary:
      'Add a stock to the watch list. watch.add <code> [market=a] group=<name> [name=<label>]',
    summaryCn: '添加自选股票预警任务',
    group: 'watch',
    argsSchema,
    positional: ['code'],
  };

  constructor(
    @Inject(InstructionRegistry) registry: InstructionRegistry,
    @Inject(WatchService) private readonly watch: WatchService,
  ) {
    super(registry);
  }

  async execute(args: Args, ctx: InstructionCtx): Promise<InstructionResult> {
    if (!isValidWatchCode(args.market, args.code)) {
      return errResult('validation', `code ${args.code} is not valid for market ${args.market}`);
    }

    let stockName = args.name;
    if (stockName === undefined) {
      try {
        const basic = await this.watch.lookup(args.market, args.code);
        stockName = basic.name;
      } catch {
        stockName = args.code;
      }
    }

    const payload: WatchTaskCreate = {
      market: args.market,
      code: args.code,
      name: stockName,
      groupName: args.group,
      remaining: null,
      notifySlack: true,
      enabled: true,
    };

    let task;
    try {
      task = await this.watch.create(ctx.userId, payload);
    } catch (err) {
      if (err instanceof QuantError) {
        return errResult('validation', err.message);
      }
      throw err;
    }

    return okResult(
      `w${String(task.idx)} added: ${args.market}:${args.code} "${stockName}" in group ${args.group}`,
    );
  }
}
