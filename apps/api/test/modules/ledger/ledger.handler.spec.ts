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
  args: { sub?: 'list' | 'summary'; limit?: number } = {},
): Promise<InstructionResult> {
  return h.execute({ sub: args.sub ?? 'summary', limit: args.limit ?? 5 }, ctx);
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

  it('renders a summary by default', async () => {
    const data = [
      entry('2026-05-01', '100', '10100', '1.0'),
      entry('2026-05-02', '-50', '10050', '-0.49'),
      entry('2026-05-03', '20', '10070', '0.20'),
    ];
    const r = await run(build(data));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.text).toContain('ledger summary (2026-05-01 → 2026-05-03)');
      expect(r.output.text).toContain('entries: 3');
      expect(r.output.text).toContain('total pnl: 70.00');
      expect(r.output.text).toContain('wins: 2');
      expect(r.output.text).toContain('losses: 1');
    }
  });

  it('lists the most recent N entries newest-first', async () => {
    const data = [
      entry('2026-05-01', '1', '10001', '0.01'),
      entry('2026-05-02', '2', '10003', '0.02'),
      entry('2026-05-03', '3', '10006', '0.03'),
    ];
    const r = await run(build(data), { sub: 'list', limit: 2 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const lines = r.output.text.split('\n');
      expect(lines[0]).toContain('last 2 of 3');
      expect(lines[1]).toContain('2026-05-03');
      expect(lines[2]).toContain('2026-05-02');
    }
  });
});
