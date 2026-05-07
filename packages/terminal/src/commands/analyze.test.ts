/**
 * Behavior tests for the `analyze` command — focused on the new
 * `analyze ta` subcommand. The sector / single-stock paths are covered
 * implicitly by the action registry tests; here we just assert that the
 * `ta` branch dispatches to `analyzeTaAction` (or to the picker on bare
 * invocation) without leaking into the bare-stock path.
 */

import type { TaAnalysis } from '@quant/shared';
import { describe, expect, it, vi } from 'vitest';
import { analyzeTaAction } from '../actions/registry.js';
import { EMPTY_STOCK_INDEX, buildStockIndex, type StockIndex } from '../completion/stock-index.js';
import type { CommandCtx, CommandSpec } from '../registry.js';
import { analyzeCommand } from './analyze.js';

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
    stores: {
      ui: {
        getFocusCode: () => null,
        setFocusCode: () => {},
      },
    },
    signal: new AbortController().signal,
  };
}

const fakeTa: TaAnalysis = {
  code: '600519',
  asof: '2026-05-06',
  barsCount: 90,
  supportLevels: [],
  resistanceLevels: [],
  trend: { direction: 'up', horizonDays: 10, confidence: 0.6, rationale: '' },
  patterns: [],
  caveats: [],
  provider: 'moonshot',
  cachedAt: '2026-05-06T08:00:00.000Z',
};

const argv = (positional: readonly string[], flags: Record<string, string | boolean> = {}) =>
  ({ positional, flags }) as Parameters<CommandSpec['run']>[0];

describe('analyze command — `ta` subcommand', () => {
  it('declares ta among its subcommands', () => {
    expect(analyzeCommand.subcommands).toEqual(expect.arrayContaining(['sector', 'ta']));
  });

  it('analyze ta <code> dispatches analyzeTaAction', async () => {
    const run = vi.fn().mockResolvedValue({ data: fakeTa, cached: false });
    const ctx = makeCtx({
      actions: {
        id: 'mock' as const,
        run,
        invalidate: vi.fn(),
        stats: () => ({ entries: 0, hits: 0, misses: 0 }),
      },
    });
    const out = await analyzeCommand.run(argv(['ta', '600519']), ctx);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toBe(analyzeTaAction);
    expect(run.mock.calls[0]?.[1]).toEqual({ code: '600519' });
    expect(out.kind).toBe('text');
  });

  it('analyze ta <code> --force opens a confirm widget without calling the runner', async () => {
    const run = vi.fn();
    const ctx = makeCtx({
      actions: {
        id: 'mock' as const,
        run,
        invalidate: vi.fn(),
        stats: () => ({ entries: 0, hits: 0, misses: 0 }),
      },
    });
    const out = await analyzeCommand.run(argv(['ta', '600519'], { force: true }), ctx);
    expect(run).not.toHaveBeenCalled();
    expect(out.kind).toBe('interactive');
  });

  it('analyze ta (no code) returns an interactive picker, not an error', async () => {
    const ctx = makeCtx({
      stockIndex: buildStockIndex([
        { code: '600519', name: '贵州茅台', pinyin: 'GZMT', industry: '白酒', market: 'a' },
      ]),
    });
    const out = await analyzeCommand.run(argv(['ta']), ctx);
    expect(out.kind).toBe('interactive');
  });

  it('analyze ta with non-6-digit code returns a usage hint', async () => {
    const ctx = makeCtx();
    const out = await analyzeCommand.run(argv(['ta', 'abc']), ctx);
    expect(out.kind).toBe('text');
    if (out.kind === 'text') {
      expect(out.tail.body).toMatch(/usage: analyze ta/u);
    }
  });
});
