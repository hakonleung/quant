/**
 * `/ledger analyze` — kick off the LLM-driven ledger review from IM.
 *
 * Aligns with the term widget's `analyze.ledger` action (calls
 * `LedgerService.analyze` directly). Replaces the previous misnamed
 * `/analyze` handler that lived on the ledger module — `/analyze`
 * itself was reclaimed by the sentiment per-stock instruction so
 * the IM surface mirrors the term action map (`analyze.one` /
 * `analyze.many` → sentiment, `analyze.ledger` → ledger LLM).
 *
 * Subcommand resolution: typing `/ledger analyze [fresh=1]` goes
 * through the parser's `<head>.<sub>` lookup and routes here because
 * the registered id is `ledger.analyze`. The default `/ledger` parent
 * still serves the cheap list/summary path.
 *
 * Async + costsCredits: the underlying `LedgerService.analyze` calls
 * `LlmService.completeJson` (5–15 s typical) and the IM listener fires
 * a "started" card / pushes a "completed" card via
 * `InstructionAsyncProcessor`.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  LedgerAnalyzeArgsSchema,
  errResult,
  instructionId,
  okResult,
  QuantError,
  type InstructionResult,
  type LedgerAnalysis,
} from '@quant/shared';
import type { z } from 'zod';

import type { InstructionCtx } from '../../instruction/instruction.port.js';
import { InstructionRegistrarBase } from '../../instruction/instruction.provider.js';
import { InstructionRegistry } from '../../instruction/instruction.registry.js';
import type { InstructionSpec } from '../../instruction/instruction.types.js';
import { LedgerService } from '../ledger.service.js';

const argsSchema = LedgerAnalyzeArgsSchema;
type Args = z.infer<typeof argsSchema>;

const MAX_RECS = 5;

@Injectable()
export class LedgerAnalyzeInstructionHandler extends InstructionRegistrarBase<Args> {
  readonly spec: InstructionSpec<Args> = {
    id: instructionId('ledger.analyze'),
    summary: 'Run the LLM ledger review (paid). ledger analyze [fresh=1]',
    summaryCn: '账本 AI 复盘（与 term 的 ANALYZE 按钮等价），fresh=1 强制刷新',
    group: 'portfolio',
    argsSchema,
    mode: 'async',
    costsCredits: true,
    imAliases: ['复盘', '账本复盘', '账本分析'],
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
      return okResult(formatLedgerAnalysis(analysis));
    } catch (err) {
      if (err instanceof QuantError) {
        return errResult('handler', err.message);
      }
      throw err;
    }
  }
}

export function formatLedgerAnalysis(a: LedgerAnalysis): string {
  const recs = a.recommendations.slice(0, MAX_RECS);
  const lines = [
    `ledger analyze  ${a.windowStart} → ${a.windowEnd}  entries=${String(a.entryCount)}  via=${a.provider}`,
    `summary : ${a.summary}`,
    `style   : ${a.operationStyle}`,
    `view    : ${a.marketView}`,
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
