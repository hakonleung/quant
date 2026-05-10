/**
 * `/ta <code> [fresh=1]` — run TA analysis for one A-share code.
 *
 * Async because it calls the LLM (5–20 s). Costs credits. The result is
 * written to the TA cache store so a subsequent `ta.show <code>` can
 * serve it without re-running the LLM.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  errResult,
  instructionId,
  okResult,
  QuantError,
  type InstructionResult,
  type TaAnalysis,
} from '@quant/shared';
import { z } from 'zod';

import type { InstructionCtx } from '../../instruction/instruction.port.js';
import { InstructionRegistrarBase } from '../../instruction/instruction.provider.js';
import { InstructionRegistry } from '../../instruction/instruction.registry.js';
import type { InstructionSpec } from '../../instruction/instruction.types.js';
import { TaService } from '../ta.service.js';

const argsSchema = z
  .object({
    code: z.string().min(1).describe('A-share 6-digit stock code, e.g. 600519'),
    fresh: z
      .enum(['0', '1', 'true', 'false'])
      .default('0')
      .transform((v) => v === '1' || v === 'true')
      .describe('Bypass cache and run fresh LLM analysis'),
  })
  .strict();
type Args = z.infer<typeof argsSchema>;

@Injectable()
export class TaInstructionHandler extends InstructionRegistrarBase<Args> {
  readonly spec: InstructionSpec<Args> = {
    id: instructionId('ta'),
    summary: 'Run TA analysis for one A-share (LLM, costs credits). ta <code> [fresh=1]',
    summaryCn: '技术分析：趋势判断 + 支撑/阻力位（LLM）',
    group: 'market',
    mode: 'async',
    costsCredits: true,
    argsSchema,
    positional: ['code'],
    imAliases: ['技术', '走势', '技分'],
    examples: ['ta 600519', 'ta 600519 fresh=1'],
  };

  constructor(
    @Inject(InstructionRegistry) registry: InstructionRegistry,
    @Inject(TaService) private readonly ta: TaService,
  ) {
    super(registry);
  }

  async execute(args: Args, ctx: InstructionCtx): Promise<InstructionResult> {
    let analysis: TaAnalysis;
    try {
      analysis = await this.ta.analyzeOne(args.code, args.fresh, {
        userId: ctx.userId,
        traceId: ctx.traceId,
      });
    } catch (err) {
      if (err instanceof QuantError) {
        return errResult('validation', err.message);
      }
      throw err;
    }
    return okResult(formatTaAnalysis(analysis));
  }
}

export function formatTaAnalysis(a: TaAnalysis): string {
  const dirEmoji = { up: '↑', down: '↓', sideways: '→' }[a.trend.direction];
  const pct = (a.trend.confidence * 100).toFixed(0);
  const lines: string[] = [
    `${a.code}  asof=${a.asof}  bars=${String(a.barsCount)}`,
    `趋势: ${dirEmoji} ${a.trend.direction}  置信度=${pct}%`,
    `  ${a.trend.rationale}`,
  ];
  if (a.supportLevels.length > 0) {
    lines.push(`支撑: ${a.supportLevels.map((l) => l.price).join(' / ')}`);
  }
  if (a.resistanceLevels.length > 0) {
    lines.push(`阻力: ${a.resistanceLevels.map((l) => l.price).join(' / ')}`);
  }
  return lines.join('\n');
}
