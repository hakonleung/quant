/**
 * `/ledger` — inspect the per-user trading journal from IM.
 *
 *   /ledger                  → recent N entries (default sub=list)
 *   /ledger list limit=10    → recent N entries
 *   /ledger analyze          → routed by the subcommand parser to
 *                              `ledger.analyze` (LLM review, paid).
 *                              Aligns with the term widget's
 *                              `analyze.ledger` action.
 *
 * The previous `sub=summary` path computed a free local aggregate
 * (entries / total pnl / wins+losses). It was renamed to `analyze`
 * and now delegates to the LLM-driven `LedgerService.analyze` so the
 * IM and term surfaces produce the same payload — a "summary" without
 * the LLM was a different feature with the same name.
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  instructionId,
  okResult,
  type EnrichedLedgerEntry,
  type InstructionResult,
} from '@quant/shared';
import { z } from 'zod';

import type { InstructionCtx } from '../../instruction/instruction.port.js';
import { InstructionRegistrarBase } from '../../instruction/instruction.provider.js';
import { InstructionRegistry } from '../../instruction/instruction.registry.js';
import type { InstructionSpec } from '../../instruction/instruction.types.js';
import { LedgerService } from '../ledger.service.js';

const argsSchema = z
  .object({
    sub: z.literal('list').default('list'),
    limit: z.coerce.number().int().min(1).max(50).default(5),
  })
  .strict();

type Args = z.infer<typeof argsSchema>;

@Injectable()
export class LedgerInstructionHandler extends InstructionRegistrarBase<Args> {
  readonly spec: InstructionSpec<Args> = {
    id: instructionId('ledger'),
    summary: 'List the recent N ledger entries. `limit` defaults to 5.',
    summaryCn: '查看交易账本（最近 N 条）；analyze 子命令请用 /ledger analyze',
    group: 'portfolio',
    argsSchema,
    positional: ['sub'],
    aliases: [instructionId('ledger.list')],
    imAliases: ['账本', '账单'],
  };

  constructor(
    @Inject(InstructionRegistry) registry: InstructionRegistry,
    @Inject(LedgerService) private readonly ledger: LedgerService,
  ) {
    super(registry);
  }

  async execute(args: Args, ctx: InstructionCtx): Promise<InstructionResult> {
    const enriched = await this.ledger.enriched(ctx.userId);
    if (enriched.length === 0) return okResult('ledger is empty');
    return okResult(formatList(enriched, args.limit));
  }
}

function formatList(entries: readonly EnrichedLedgerEntry[], limit: number): string {
  const tail = entries.slice(-limit).reverse();
  const lines = tail.map((e) => {
    const pct = e.derivedDailyPct;
    return `  ${e.date}  pnl=${e.pnlAmount.padStart(10)}  pos=${e.derivedClosingPosition.padStart(12)}  pct=${pct}%`;
  });
  return `ledger (last ${String(tail.length)} of ${String(entries.length)}):\n${lines.join('\n')}`;
}
