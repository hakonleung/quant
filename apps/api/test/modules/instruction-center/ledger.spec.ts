/**
 * Tests for the /ledger (list) cell — handler + renderer.
 *
 * Covers:
 *   - empty snapshot → totalCount=0, renderer emits "ledger is empty"
 *   - newest-first slicing by limit
 *   - daily-pct sign + 2-decimal formatting
 *   - error envelope passes through
 *   - schema rejects the legacy `sub=summary` subcommand
 */

import {
  LedgerArgsSchema,
  type EnrichedLedgerEntry,
  type InstructionEnvelope,
  type ResultOf,
} from '@quant/shared';

import { buildLedgerCell } from '../../../src/modules/instruction-center/cells/ledger.cell.js';
import { renderLedger } from '../../../src/modules/instruction-center/cells/ledger.render.js';
import type { LedgerService } from '../../../src/modules/ledger/ledger.service.js';
import type { InstructionCtx } from '../../../src/modules/instruction/instruction.port.js';

type LedgerListResult = ResultOf<'ledger'>;

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

function fakeLedger(entries: readonly EnrichedLedgerEntry[]): LedgerService {
  return { enriched: () => Promise.resolve(entries) } as unknown as LedgerService;
}

describe('buildLedgerCell.handler', () => {
  it('returns totalCount=0 + empty entries for an empty snapshot', async () => {
    const cell = buildLedgerCell({ ledger: fakeLedger([]) });
    const r = await cell.handler({ sub: 'list', limit: 5 }, ctx);
    expect(r).toEqual<LedgerListResult>({ totalCount: 0, entries: [] });
  });

  it('slices the most recent N entries newest-first', async () => {
    const data = [
      entry('2026-05-01', '1', '10001', '0.01'),
      entry('2026-05-02', '2', '10003', '0.02'),
      entry('2026-05-03', '3', '10006', '0.03'),
    ];
    const cell = buildLedgerCell({ ledger: fakeLedger(data) });
    const r = await cell.handler({ sub: 'list', limit: 2 }, ctx);
    expect(r.totalCount).toBe(3);
    expect(r.entries).toHaveLength(2);
    expect(r.entries[0]?.date).toBe('2026-05-03');
    expect(r.entries[1]?.date).toBe('2026-05-02');
  });

  it('formats derivedDailyPct with sign + 2 decimals (positive)', async () => {
    const cell = buildLedgerCell({
      ledger: fakeLedger([entry('2026-05-01', '1', '10001', '1.234')]),
    });
    const r = await cell.handler({ sub: 'list', limit: 5 }, ctx);
    expect(r.entries[0]?.dailyPctDisplay).toBe('+1.23%');
  });

  it('formats negative pct without injecting a `+` sign', async () => {
    const cell = buildLedgerCell({
      ledger: fakeLedger([entry('2026-05-01', '-1', '10000', '-0.456')]),
    });
    const r = await cell.handler({ sub: 'list', limit: 5 }, ctx);
    expect(r.entries[0]?.dailyPctDisplay).toBe('-0.46%');
  });

  it('falls back to raw + `%` on unparseable pct strings', async () => {
    const cell = buildLedgerCell({
      ledger: fakeLedger([entry('2026-05-01', '1', '10000', 'nan')]),
    });
    const r = await cell.handler({ sub: 'list', limit: 5 }, ctx);
    expect(r.entries[0]?.dailyPctDisplay).toBe('nan%');
  });
});

describe('renderLedger', () => {
  function okEnv(data: LedgerListResult): InstructionEnvelope<LedgerListResult> {
    return { ok: true, data };
  }

  it('renders "ledger is empty" when totalCount=0', () => {
    const out = renderLedger(okEnv({ totalCount: 0, entries: [] }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output.text).toBe('ledger is empty');
    expect(out.output.meta).toBeUndefined();
  });

  it('renders header "last N of total" and per-entry rows', () => {
    const out = renderLedger(
      okEnv({
        totalCount: 3,
        entries: [
          { date: '2026-05-03', pnlAmount: '3', closingPosition: '10006', dailyPctDisplay: '+0.03%' },
          { date: '2026-05-02', pnlAmount: '2', closingPosition: '10003', dailyPctDisplay: '+0.02%' },
        ],
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output.text).toContain('last 2 of 3');
    expect(out.output.text).toContain('2026-05-03');
    expect(out.output.text).toContain('+0.03%');
    expect(out.output.meta).toBeDefined();
    const meta = out.output.meta as {
      tablesSubheader: string;
      tableSections: { rows: { date: string; pct: string }[] }[];
    };
    expect(meta.tablesSubheader).toBe('ledger (last 2 of 3)');
    expect(meta.tableSections[0]?.rows[0]?.date).toBe('2026-05-03');
    expect(meta.tableSections[0]?.rows[0]?.pct).toBe('+0.03%');
  });

  it('passes through error envelope verbatim', () => {
    const out = renderLedger({ ok: false, error: { code: 'handler', message: 'boom' } });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toEqual({ code: 'handler', message: 'boom' });
  });
});

describe('LedgerArgsSchema (regression)', () => {
  it('rejects the legacy `sub=summary` subcommand', () => {
    // `summary` was removed when summary semantics moved to the
    // LLM-driven `ledger.analyze`. Keep the regression test.
    expect(LedgerArgsSchema.safeParse({ sub: 'summary' }).success).toBe(false);
  });
});
