/**
 * `/ledger` — inspect the per-user trading journal from IM.
 *
 *   /ledger                  → summary (default)
 *   /ledger sub=list         → recent N entries (default limit=5)
 *   /ledger sub=list limit=10
 *   /ledger sub=summary
 *
 * Reads via `LedgerService.enriched(userId)` so derived columns
 * (closingPosition, dailyPct, cashFlow) are already filled in. No
 * service-side changes required.
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
    sub: z.enum(['list', 'summary']).default('summary'),
    limit: z.coerce.number().int().min(1).max(50).default(5),
  })
  .strict();

type Args = z.infer<typeof argsSchema>;

@Injectable()
export class LedgerInstructionHandler extends InstructionRegistrarBase<Args> {
  readonly spec: InstructionSpec<Args> = {
    id: instructionId('ledger'),
    summary: 'Inspect the per-user ledger. `sub=list|summary`, `limit` (list only).',
    summaryCn: '查看交易账本，sub=list|summary',
    group: 'portfolio',
    argsSchema,
    positional: ['sub'],
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
    if (args.sub === 'list') return okResult(formatList(enriched, args.limit));
    return okResult(formatSummary(enriched));
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

function formatSummary(entries: readonly EnrichedLedgerEntry[]): string {
  const first = entries[0];
  const last = entries[entries.length - 1];
  if (first === undefined || last === undefined) return 'ledger is empty';
  const totalPnl = entries.reduce((sum, e) => sum + Number(e.pnlAmount), 0);
  const wins = entries.filter((e) => Number(e.pnlAmount) > 0).length;
  const losses = entries.filter((e) => Number(e.pnlAmount) < 0).length;
  return [
    `ledger summary (${first.date} → ${last.date})`,
    `  entries: ${String(entries.length)}`,
    `  total pnl: ${totalPnl.toFixed(2)}`,
    `  wins: ${String(wins)}  losses: ${String(losses)}`,
    `  closing position: ${last.derivedClosingPosition}`,
  ].join('\n');
}
