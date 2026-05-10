/**
 * `ta.show <code>` — display the most-recent cached TA analysis without
 * re-running the LLM.  If no cached entry exists (or the kline data is
 * absent) the user is prompted to run `ta <code>` first.
 */

import { Inject, Injectable } from '@nestjs/common';
import { instructionId, okResult, type InstructionResult } from '@quant/shared';
import { z } from 'zod';

import type { InstructionCtx } from '../../instruction/instruction.port.js';
import { InstructionRegistrarBase } from '../../instruction/instruction.provider.js';
import { InstructionRegistry } from '../../instruction/instruction.registry.js';
import type { InstructionSpec } from '../../instruction/instruction.types.js';
import { TaService } from '../ta.service.js';
import { formatTaAnalysis } from './ta.handler.js';

const argsSchema = z
  .object({
    code: z.string().min(1).describe('A-share 6-digit stock code, e.g. 600519'),
  })
  .strict();
type Args = z.infer<typeof argsSchema>;

@Injectable()
export class TaShowInstructionHandler extends InstructionRegistrarBase<Args> {
  readonly spec: InstructionSpec<Args> = {
    id: instructionId('ta.show'),
    summary: 'Show cached TA analysis for a stock (no LLM). ta.show <code>',
    summaryCn: '查看已缓存的技术分析结果',
    group: 'market',
    argsSchema,
    positional: ['code'],
    imAliases: ['ta查询'],
    // Per the IM-handler convention every /ta.* surface goes through the
    // agent confirm flow before running — even the free cache read,
    // because the user explicitly opted into "all /ta instructions need
    // user confirmation". The cache lookup is still free; the flag only
    // gates `AgentToolBridge.needsConfirmation` and the IM "[$]" tag.
    costsCredits: true,
  };

  constructor(
    @Inject(InstructionRegistry) registry: InstructionRegistry,
    @Inject(TaService) private readonly ta: TaService,
  ) {
    super(registry);
  }

  async execute(args: Args, ctx: InstructionCtx): Promise<InstructionResult> {
    const analysis = await this.ta.getCached(args.code, ctx.traceId);
    if (analysis === null) {
      return okResult(`no cached analysis for ${args.code} — run \`ta ${args.code}\` to generate`);
    }
    return okResult(formatTaAnalysis(analysis));
  }
}
