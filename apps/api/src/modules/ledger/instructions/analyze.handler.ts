/**
 * `/analyze` — kick off the LLM-driven ledger analysis from IM.
 *
 *   /analyze            → use cached result if available
 *   /analyze fresh=1    → bypass cache, force a fresh LLM call
 *
 * Flagged `mode: 'async'` because the underlying Flight `analyze_ledger`
 * op routes through Moonshot / OpenAI (5–15s typical). The IM listener
 * posts a "started" card immediately and a "completed" card when the
 * worker finishes — see `InstructionAsyncProcessor`.
 *
 * Output is a condensed text view; the full structured `LedgerAnalysis`
 * is still available via `GET /api/ledger/analysis`.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  errResult,
  instructionId,
  okResult,
  QuantError,
  type InstructionResult,
  type LedgerAnalysis,
} from '@quant/shared';
import { z } from 'zod';

import type { InstructionCtx } from '../../instruction/instruction.port.js';
import { InstructionRegistrarBase } from '../../instruction/instruction.provider.js';
import { InstructionRegistry } from '../../instruction/instruction.registry.js';
import type { InstructionSpec } from '../../instruction/instruction.types.js';
import { LedgerService } from '../ledger.service.js';

const truthy = new Set(['1', 'true', 'yes']);

const argsSchema = z
  .object({
    fresh: z
      .union([z.string(), z.boolean()])
      .optional()
      .transform((v) => {
        if (v === undefined) return false;
        if (typeof v === 'boolean') return v;
        return truthy.has(v.toLowerCase());
      }),
  })
  .strict();

type Args = z.infer<typeof argsSchema>;

const MAX_RECS = 5;

@Injectable()
export class AnalyzeInstructionHandler extends InstructionRegistrarBase<Args> {
  readonly spec: InstructionSpec<Args> = {
    id: instructionId('analyze'),
    summary: 'Run the LLM ledger review. `fresh=1` bypasses the cache.',
    argsSchema,
    mode: 'async',
  };

  constructor(
    @Inject(InstructionRegistry) registry: InstructionRegistry,
    @Inject(LedgerService) private readonly ledger: LedgerService,
  ) {
    super(registry);
  }

  async execute(args: Args, ctx: InstructionCtx): Promise<InstructionResult> {
    try {
      const analysis = await this.ledger.analyze(ctx.userId, ctx.traceId, args.fresh);
      return okResult(formatAnalysis(analysis));
    } catch (err) {
      if (err instanceof QuantError) {
        return errResult('handler', err.message);
      }
      throw err;
    }
  }
}

function formatAnalysis(a: LedgerAnalysis): string {
  const recs = a.recommendations.slice(0, MAX_RECS);
  const lines = [
    `analyze ${a.windowStart} → ${a.windowEnd}  entries=${String(a.entryCount)}  via=${a.provider}`,
    `summary: ${a.summary}`,
    `style:   ${a.operationStyle}`,
    `view:    ${a.marketView}`,
  ];
  if (recs.length > 0) {
    lines.push(`recommendations:`);
    recs.forEach((r, i) => lines.push(`  ${String(i + 1)}. ${r}`));
    if (a.recommendations.length > MAX_RECS) {
      lines.push(`  …(+${String(a.recommendations.length - MAX_RECS)} more)`);
    }
  }
  return lines.join('\n');
}
