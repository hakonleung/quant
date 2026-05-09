/**
 * Behavior tests for the `analyze` command.
 *
 * `ta` was extracted into its own top-level command — see `ta.test.ts`
 * for the technical-analysis paths.
 */

import { describe, expect, it, vi } from 'vitest';
import { analyzeOneAction } from '../actions/registry.js';
import { EMPTY_STOCK_INDEX, type StockIndex } from '../completion/stock-index.js';
import type { CommitResolution } from '../engine/state.js';
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

const fakeSentiment = {
  code: '600519',
  score: 0.4,
  theme: 'liquor',
  driver: 'earnings',
  cachedAt: '2026-05-06T08:00:00.000Z',
  result: '## 茅台\n\n白酒板块龙头，季度业绩稳健。',
};

const argv = (positional: readonly string[], flags: Record<string, string | boolean> = {}) =>
  ({ positional, flags }) as Parameters<CommandSpec['run']>[0];

describe('analyze command — subcommand surface', () => {
  it('declares only `sector` as a subcommand (ta moved to top-level)', () => {
    expect(analyzeCommand.subcommands).toEqual(['sector']);
  });

  it('analyze ta is no longer accepted — falls through to invalid-code', async () => {
    const ctx = makeCtx();
    const out = await analyzeCommand.run(argv(['ta']), ctx);
    expect(out.kind).toBe('text');
    if (out.kind === 'text') {
      expect(out.tail.body).toMatch(/invalid code/u);
    }
  });
});

describe('analyze command — reading-mode selector wiring', () => {
  it('analyze <code> dispatches analyzeOneAction and returns reading-mode picker', async () => {
    const run = vi.fn().mockResolvedValue({ data: fakeSentiment, cached: false });
    const ctx = makeCtx({
      actions: {
        id: 'mock' as const,
        run,
        invalidate: vi.fn(),
        stats: () => ({ entries: 0, hits: 0, misses: 0 }),
      },
    });
    const out = await analyzeCommand.run(argv(['600519']), ctx);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toBe(analyzeOneAction);
    expect(out.kind).toBe('interactive');
    if (out.kind === 'interactive') {
      expect(out.widget.title).toMatch(/analyze 600519/u);
    }
  });

  it('reading-mode brief commits inline output', async () => {
    const run = vi.fn().mockResolvedValue({ data: fakeSentiment, cached: true });
    const ctx = makeCtx({
      actions: {
        id: 'mock' as const,
        run,
        invalidate: vi.fn(),
        stats: () => ({ entries: 0, hits: 0, misses: 0 }),
      },
    });
    const out = await analyzeCommand.run(argv(['600519']), ctx);
    if (out.kind !== 'interactive') throw new Error('expected interactive');
    const widget = out.widget;
    const step = widget.handleKey(widget.initialState, { text: 'b' });
    expect(step.kind).toBe('submit');
    if (step.kind !== 'submit') throw new Error('unreachable');
    const commit = widget.commit ?? ((r: CommitResolution): CommitResolution => r);
    const resolution = commit(step.result as CommitResolution);
    expect(resolution.kind).toBe('output');
  });

  it('reading-mode detail opens the pager widget', async () => {
    const run = vi.fn().mockResolvedValue({ data: fakeSentiment, cached: false });
    const ctx = makeCtx({
      actions: {
        id: 'mock' as const,
        run,
        invalidate: vi.fn(),
        stats: () => ({ entries: 0, hits: 0, misses: 0 }),
      },
    });
    const out = await analyzeCommand.run(argv(['600519']), ctx);
    if (out.kind !== 'interactive') throw new Error('expected interactive');
    const widget = out.widget;
    const step = widget.handleKey(widget.initialState, { text: 'd' });
    expect(step.kind).toBe('submit');
    if (step.kind !== 'submit') throw new Error('unreachable');
    const commit = widget.commit ?? ((r: CommitResolution): CommitResolution => r);
    const resolution = commit(step.result as CommitResolution);
    expect(resolution.kind).toBe('widget');
  });
});
