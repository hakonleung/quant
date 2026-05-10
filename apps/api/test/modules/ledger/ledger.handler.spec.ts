import { instructionId, type EnrichedLedgerEntry, type InstructionResult } from '@quant/shared';

import { LedgerInstructionHandler } from '../../../src/modules/ledger/instructions/ledger.handler.js';
import type { LedgerService } from '../../../src/modules/ledger/ledger.service.js';
import { InstructionRegistry } from '../../../src/modules/instruction/instruction.registry.js';
import type { InstructionCtx } from '../../../src/modules/instruction/instruction.port.js';

const ctx: InstructionCtx = { traceId: 't1', source: 'im', userId: 'feishu:ou_a' };

function entry(date: string, pnl: string, closing: string, pct: string): EnrichedLedgerEntry {
  return {
    date,
    pnlAmount: pnl,
    derivedClosingPosition: closing,
    closingProvided: false,
    derivedDailyPct: pct,
    cashFlow: '0',
  };
}

function build(entries: readonly EnrichedLedgerEntry[]): LedgerInstructionHandler {
  const reg = new InstructionRegistry();
  const ledger: Pick<LedgerService, 'enriched'> = {
    enriched: () => Promise.resolve(entries),
  };
  return new LedgerInstructionHandler(reg, ledger as unknown as LedgerService);
}

async function run(
  h: LedgerInstructionHandler,
  args: { limit?: number } = {},
): Promise<InstructionResult> {
  return h.execute({ sub: 'list', limit: args.limit ?? 5 }, ctx);
}

describe('LedgerInstructionHandler', () => {
  it('declares a v1.5 spec id `ledger`', () => {
    const h = build([]);
    expect(h.spec.id).toBe(instructionId('ledger'));
  });

  it('reports an empty ledger', async () => {
    const r = await run(build([]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output.text).toBe('ledger is empty');
  });

  it('lists the most recent N entries newest-first', async () => {
    const data = [
      entry('2026-05-01', '1', '10001', '0.01'),
      entry('2026-05-02', '2', '10003', '0.02'),
      entry('2026-05-03', '3', '10006', '0.03'),
    ];
    const r = await run(build(data), { limit: 2 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const lines = r.output.text.split('\n');
      expect(lines[0]).toContain('last 2 of 3');
      expect(lines[1]).toContain('2026-05-03');
      expect(lines[2]).toContain('2026-05-02');
    }
  });

  it('drops the legacy `summary` subcommand — analyze is the new term-aligned path', () => {
    const h = build([]);
    // Schema only accepts `sub: "list"` now; `summary` should be a parse error.
    const result = h.spec.argsSchema.safeParse({ sub: 'summary' });
    expect(result.success).toBe(false);
  });
});
