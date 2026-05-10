/**
 * Behavior tests for the new top-level `ta` command. Mirrors the
 * `analyze` reading-mode tests; covers the single-stock and `ta sector`
 * paths and the no-arg guided picker.
 */

import type { TaAnalysis, TaSectorAnalysis } from '@quant/shared';
import { describe, expect, it, vi } from 'vitest';

import { analyzeTaAction, analyzeTaManyAction, sectorShowAction } from '../actions/registry.js';
import { EMPTY_STOCK_INDEX, buildStockIndex, type StockIndex } from '../completion/stock-index.js';
import type { CommandCtx, CommandSpec } from '../registry.js';
import { taCommand } from './ta.js';

function makeCtx(overrides: Partial<CommandCtx> = {}): CommandCtx {
  const stockIndex: StockIndex = overrides.stockIndex ?? EMPTY_STOCK_INDEX;
  const runner = overrides.actions ?? {
    id: 'mock' as const,
    run: vi.fn(),
    invalidate: vi.fn(),
    stats: () => ({ entries: 0, hits: 0, misses: 0 }),
  };
  return {
    actions: runner,
    stockIndex,
    stores: { ui: { getFocusCode: () => null, setFocusCode: () => {} } },
    signal: new AbortController().signal,
  };
}

const fakeTa: TaAnalysis = {
  code: '600519',
  asof: '2026-05-06',
  barsCount: 90,
  supportLevels: [],
  resistanceLevels: [],
  trend: { direction: 'up', horizonDays: 10, confidence: 0.6, rationale: 'breakout above MA60' },
  patterns: [],
  caveats: [],
  provider: 'moonshot',
  cachedAt: '2026-05-06T08:00:00.000Z',
};

const fakeSector: TaSectorAnalysis = {
  codes: ['600519', '000858'],
  trendBreakdown: { up: 2, down: 0, sideways: 0 },
  overallDirection: 'up',
  overallConfidence: 0.7,
  members: [
    {
      code: '600519',
      name: '茅台',
      asof: '2026-05-06',
      trend: fakeTa.trend,
      keyResistance: '1900.00',
      keySupport: '1700.00',
      headline: 'breakout',
    },
  ],
  summary: '白酒板块整体上行。',
  caveats: [],
  cachedAt: '2026-05-06T08:00:00.000Z',
};

const argv = (positional: readonly string[], flags: Record<string, string | boolean> = {}) =>
  ({ positional, flags }) as Parameters<CommandSpec['run']>[0];

describe('ta command — surface', () => {
  it('declares sector as its only subcommand', () => {
    expect(taCommand.subcommands).toEqual(['sector']);
  });
});

describe('ta <code>', () => {
  it('dispatches analyzeTaAction and returns the reading-mode selector', async () => {
    const run = vi.fn().mockResolvedValue({ data: fakeTa, cached: false });
    const ctx = makeCtx({
      actions: {
        id: 'mock' as const,
        run,
        invalidate: vi.fn(),
        stats: () => ({ entries: 0, hits: 0, misses: 0 }),
      },
    });
    const out = await taCommand.run(argv(['600519']), ctx);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toBe(analyzeTaAction);
    expect(run.mock.calls[0]?.[1]).toEqual({ code: '600519' });
    expect(out.kind).toBe('interactive');
  });

  it('--force opens a confirm widget without dispatching the runner', async () => {
    const run = vi.fn();
    const ctx = makeCtx({
      actions: {
        id: 'mock' as const,
        run,
        invalidate: vi.fn(),
        stats: () => ({ entries: 0, hits: 0, misses: 0 }),
      },
    });
    const out = await taCommand.run(argv(['600519'], { force: true }), ctx);
    expect(run).not.toHaveBeenCalled();
    expect(out.kind).toBe('interactive');
  });

  it('rejects non-6-digit code', async () => {
    const ctx = makeCtx();
    const out = await taCommand.run(argv(['abc']), ctx);
    expect(out.kind).toBe('text');
    if (out.kind === 'text') {
      expect(out.tail.body).toMatch(/invalid code/u);
    }
  });

  it('no arg returns the guided picker', async () => {
    const ctx = makeCtx({
      stockIndex: buildStockIndex([
        { code: '600519', name: '茅台', pinyin: 'MT', industry: '白酒', market: 'a' },
      ]),
    });
    const out = await taCommand.run(argv([]), ctx);
    expect(out.kind).toBe('interactive');
  });
});

describe('ta sector <id|name>', () => {
  it('looks up the sector then dispatches analyzeTaManyAction', async () => {
    const sector = {
      id: 'tech',
      name: 'Tech',
      kind: 'user' as const,
      count: 2,
      meta: '',
      chgPct: null,
      codes: ['600519', '000858'],
      createdBy: 'admin',
      published: false,
    };
    const run = vi.fn().mockImplementation(async (action: unknown) => {
      if (action === sectorShowAction) return { data: sector, cached: false };
      if (action === analyzeTaManyAction) return { data: fakeSector, cached: false };
      throw new Error('unexpected action');
    });
    const ctx = makeCtx({
      actions: {
        id: 'mock' as const,
        run,
        invalidate: vi.fn(),
        stats: () => ({ entries: 0, hits: 0, misses: 0 }),
      },
    });
    const out = await taCommand.run(argv(['sector', 'tech']), ctx);
    expect(run.mock.calls[0]?.[0]).toBe(sectorShowAction);
    expect(run.mock.calls[1]?.[0]).toBe(analyzeTaManyAction);
    expect(run.mock.calls[1]?.[1]).toEqual({ codes: sector.codes, label: sector.name });
    expect(out.kind).toBe('interactive');
  });

  it('missing arg returns usage hint', async () => {
    const ctx = makeCtx();
    const out = await taCommand.run(argv(['sector']), ctx);
    expect(out.kind).toBe('text');
    if (out.kind === 'text') {
      expect(out.tail.body).toMatch(/usage: ta sector/u);
    }
  });
});
