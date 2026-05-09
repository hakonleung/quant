import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ChatTokenUsage, LedgerEntry } from '@quant/shared';

import { FrozenClock } from '../../../src/common/clock.js';
import type { AuthConfigShape } from '../../../src/modules/auth/config/auth.config.js';
import { LedgerCacheStore } from '../../../src/modules/ledger/ledger-cache.store.js';
import { LedgerService } from '../../../src/modules/ledger/ledger.service.js';
import { LedgerStore } from '../../../src/modules/ledger/ledger.store.js';
import type { LlmService } from '../../../src/modules/llm/llm.service.js';

const FROZEN = new Date('2026-05-08T00:00:00.000Z');
const USER = 'admin';

const ZERO_USAGE: ChatTokenUsage = { input: 0, output: 0, total: 0 };

interface FakeLlmCall {
  readonly system: string;
  readonly user: string;
  readonly userId: string;
}

interface FakeLlmResult {
  readonly text: string;
  readonly provider?: string;
  readonly usage?: ChatTokenUsage;
}

function fakeLlm(rounds: readonly FakeLlmResult[]): {
  llm: LlmService;
  calls: FakeLlmCall[];
} {
  const calls: FakeLlmCall[] = [];
  let cursor = 0;
  const llm = {
    completeJson: async (
      args: { system: string; user: string },
      ctx: { userId: string; traceId: string; scope: string },
    ): Promise<{ text: string; usage: ChatTokenUsage; provider: string; model: string }> => {
      calls.push({ system: args.system, user: args.user, userId: ctx.userId });
      const round = rounds[cursor];
      cursor += 1;
      if (round === undefined) throw new Error('fakeLlm: no more scripted rounds');
      return {
        text: round.text,
        usage: round.usage ?? ZERO_USAGE,
        provider: round.provider ?? 'moonshot',
        model: 'kimi-k2.6',
      };
    },
  } as unknown as LlmService;
  return { llm, calls };
}

const SAMPLE_PAYLOAD = {
  summary: '过去三日整体小幅盈利',
  operation_style: '稳健加减仓',
  market_view: '震荡偏强',
  recommendations: ['保持当前仓位'],
};

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'ledger-svc-'));
}

function cfg(dataRoot: string): AuthConfigShape {
  return {
    mode: 'disabled',
    nextauthSecret: null,
    dataRoot,
    adminUserId: 'admin',
    adminUserIds: new Set<string>(),
  };
}

async function setup(seed: readonly LedgerEntry[] = []): Promise<{
  store: LedgerStore;
  cache: LedgerCacheStore;
  root: string;
}> {
  const root = await tmpRoot();
  if (seed.length > 0) {
    const dir = path.join(root, 'users', USER, '_ledger');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'entries.json'), JSON.stringify({ entries: seed }));
  }
  const store = new LedgerStore(cfg(root));
  const cache = new LedgerCacheStore(cfg(root));
  return { store, cache, root };
}

describe('LedgerService.create', () => {
  it('rejects duplicate dates', async () => {
    const { store, cache } = await setup([
      { date: '2026-05-01', pnlAmount: '0', closingPosition: '100000' },
    ]);
    const { llm } = fakeLlm([]);
    const svc = new LedgerService(store, cache, llm, new FrozenClock(FROZEN));
    await expect(
      svc.create(USER, { date: '2026-05-01', pnlAmount: '5', closingPosition: '100050' }),
    ).rejects.toMatchObject({ code: 'LEDGER_DUPLICATE_DATE' });
  });

  it('rejects when first entry has no closingPosition', async () => {
    const { store, cache } = await setup();
    const { llm } = fakeLlm([]);
    const svc = new LedgerService(store, cache, llm, new FrozenClock(FROZEN));
    await expect(svc.create(USER, { date: '2026-05-01', pnlAmount: '5' })).rejects.toMatchObject({
      code: 'LEDGER_FIRST_NEEDS_CLOSING_POSITION',
    });
  });

  it('accepts a non-anchor entry without closingPosition once an anchor exists', async () => {
    const { store, cache } = await setup([
      { date: '2026-05-01', pnlAmount: '0', closingPosition: '100000' },
    ]);
    const { llm } = fakeLlm([]);
    const svc = new LedgerService(store, cache, llm, new FrozenClock(FROZEN));
    await svc.create(USER, { date: '2026-05-02', pnlAmount: '500' });
    await store.flushNow(USER);
    const list = await svc.list(USER);
    expect(list.map((e) => e.date)).toEqual(['2026-05-01', '2026-05-02']);
  });
});

describe('LedgerService.patch', () => {
  it('updates pnlAmount on an existing entry', async () => {
    const { store, cache } = await setup([
      { date: '2026-05-01', pnlAmount: '0', closingPosition: '100000' },
      { date: '2026-05-02', pnlAmount: '500' },
    ]);
    const { llm } = fakeLlm([]);
    const svc = new LedgerService(store, cache, llm, new FrozenClock(FROZEN));
    const next = await svc.patch(USER, '2026-05-02', { pnlAmount: '700' });
    expect(next.pnlAmount).toBe('700');
  });

  it('throws NOT_FOUND for an unknown date', async () => {
    const { store, cache } = await setup([
      { date: '2026-05-01', pnlAmount: '0', closingPosition: '100000' },
    ]);
    const { llm } = fakeLlm([]);
    const svc = new LedgerService(store, cache, llm, new FrozenClock(FROZEN));
    await expect(svc.patch(USER, '2099-12-31', { pnlAmount: '0' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('clears closingPosition when caller passes null', async () => {
    const { store, cache } = await setup([
      { date: '2026-05-01', pnlAmount: '0', closingPosition: '100000' },
      { date: '2026-05-02', pnlAmount: '500', closingPosition: '100500' },
    ]);
    const { llm } = fakeLlm([]);
    const svc = new LedgerService(store, cache, llm, new FrozenClock(FROZEN));
    const next = await svc.patch(USER, '2026-05-02', { closingPosition: null });
    expect(next.closingPosition).toBeNull();
  });
});

describe('LedgerService.remove', () => {
  it('rejects when removing the anchor exposes a non-anchor next entry', async () => {
    const { store, cache } = await setup([
      { date: '2026-05-01', pnlAmount: '0', closingPosition: '100000' },
      { date: '2026-05-02', pnlAmount: '500' },
    ]);
    const { llm } = fakeLlm([]);
    const svc = new LedgerService(store, cache, llm, new FrozenClock(FROZEN));
    await expect(svc.remove(USER, '2026-05-01')).rejects.toMatchObject({
      code: 'LEDGER_FIRST_NEEDS_CLOSING_POSITION',
    });
  });

  it('removes a non-anchor entry without complaint', async () => {
    const { store, cache } = await setup([
      { date: '2026-05-01', pnlAmount: '0', closingPosition: '100000' },
      { date: '2026-05-02', pnlAmount: '500' },
    ]);
    const { llm } = fakeLlm([]);
    const svc = new LedgerService(store, cache, llm, new FrozenClock(FROZEN));
    await svc.remove(USER, '2026-05-02');
    const list = await svc.list(USER);
    expect(list.map((e) => e.date)).toEqual(['2026-05-01']);
  });
});

describe('LedgerService.importEntries', () => {
  it('imported entries overwrite existing dates', async () => {
    const { store, cache } = await setup([
      { date: '2026-05-01', pnlAmount: '0', closingPosition: '100000' },
      { date: '2026-05-02', pnlAmount: '500' },
    ]);
    const { llm } = fakeLlm([]);
    const svc = new LedgerService(store, cache, llm, new FrozenClock(FROZEN));
    await svc.importEntries(USER, [{ date: '2026-05-02', pnlAmount: '999' }]);
    const list = await svc.list(USER);
    expect(list.find((e) => e.date === '2026-05-02')?.pnlAmount).toBe('999');
  });
});

describe('LedgerService.analyze', () => {
  it('returns cached payload without calling LLM when warm', async () => {
    const { store, cache } = await setup([
      { date: '2026-05-01', pnlAmount: '0', closingPosition: '100000' },
    ]);
    const { llm, calls } = fakeLlm([{ text: JSON.stringify(SAMPLE_PAYLOAD) }]);
    const svc = new LedgerService(store, cache, llm, new FrozenClock(FROZEN));

    const first = await svc.analyze(USER, 't-1');
    const second = await svc.analyze(USER, 't-2');

    expect(first.summary).toBe('过去三日整体小幅盈利');
    expect(first.provider).toBe('moonshot');
    expect(first.entryCount).toBe(1);
    expect(second).toEqual(first);
    expect(calls.length).toBe(1);
  });

  it('forces a fresh LLM call when bypassCache is true', async () => {
    const { store, cache } = await setup([
      { date: '2026-05-01', pnlAmount: '0', closingPosition: '100000' },
    ]);
    const { llm, calls } = fakeLlm([
      { text: JSON.stringify(SAMPLE_PAYLOAD) },
      { text: JSON.stringify(SAMPLE_PAYLOAD) },
    ]);
    const svc = new LedgerService(store, cache, llm, new FrozenClock(FROZEN));

    await svc.analyze(USER, 't-1');
    await svc.analyze(USER, 't-2', true);

    expect(calls.length).toBe(2);
  });

  it('passes userId to the LLM call so the ledger can attribute spend', async () => {
    const { store, cache } = await setup([
      { date: '2026-05-01', pnlAmount: '0', closingPosition: '100000' },
    ]);
    const { llm, calls } = fakeLlm([{ text: JSON.stringify(SAMPLE_PAYLOAD) }]);
    const svc = new LedgerService(store, cache, llm, new FrozenClock(FROZEN));
    await svc.analyze(USER, 't-1');
    expect(calls[0]?.userId).toBe(USER);
  });

  it('threads the resolved provider into the analysis result', async () => {
    const { store, cache } = await setup([
      { date: '2026-05-01', pnlAmount: '0', closingPosition: '100000' },
    ]);
    const { llm } = fakeLlm([{ text: JSON.stringify(SAMPLE_PAYLOAD), provider: 'qwen' }]);
    const svc = new LedgerService(store, cache, llm, new FrozenClock(FROZEN));
    const result = await svc.analyze(USER, 't-1');
    expect(result.provider).toBe('qwen');
  });

  it('throws LLM_FAILED when the ledger is empty', async () => {
    const { store, cache } = await setup();
    const { llm } = fakeLlm([]);
    const svc = new LedgerService(store, cache, llm, new FrozenClock(FROZEN));
    await expect(svc.analyze(USER, 't-1')).rejects.toMatchObject({ code: 'LLM_FAILED' });
  });

  it('throws LLM_FAILED when the LLM returns invalid JSON', async () => {
    const { store, cache } = await setup([
      { date: '2026-05-01', pnlAmount: '0', closingPosition: '100000' },
    ]);
    const { llm } = fakeLlm([{ text: 'not json at all' }]);
    const svc = new LedgerService(store, cache, llm, new FrozenClock(FROZEN));
    await expect(svc.analyze(USER, 't-1')).rejects.toMatchObject({ code: 'LLM_FAILED' });
  });

  it('throws LLM_FAILED when a required field is missing', async () => {
    const { store, cache } = await setup([
      { date: '2026-05-01', pnlAmount: '0', closingPosition: '100000' },
    ]);
    const { llm } = fakeLlm([
      {
        text: JSON.stringify({
          summary: '',
          operation_style: 'x',
          market_view: 'y',
        }),
      },
    ]);
    const svc = new LedgerService(store, cache, llm, new FrozenClock(FROZEN));
    await expect(svc.analyze(USER, 't-1')).rejects.toMatchObject({ code: 'LLM_FAILED' });
  });

  it('caps recommendations at 5', async () => {
    const { store, cache } = await setup([
      { date: '2026-05-01', pnlAmount: '0', closingPosition: '100000' },
    ]);
    const huge = Array.from({ length: 12 }, (_, i) => `rec ${String(i)}`);
    const { llm } = fakeLlm([
      {
        text: JSON.stringify({
          ...SAMPLE_PAYLOAD,
          recommendations: huge,
        }),
      },
    ]);
    const svc = new LedgerService(store, cache, llm, new FrozenClock(FROZEN));
    const result = await svc.analyze(USER, 't-1');
    expect(result.recommendations.length).toBe(5);
  });

  it('strips ```json fences in the LLM output', async () => {
    const { store, cache } = await setup([
      { date: '2026-05-01', pnlAmount: '0', closingPosition: '100000' },
    ]);
    const fenced = '```json\n' + JSON.stringify(SAMPLE_PAYLOAD) + '\n```';
    const { llm } = fakeLlm([{ text: fenced }]);
    const svc = new LedgerService(store, cache, llm, new FrozenClock(FROZEN));
    const result = await svc.analyze(USER, 't-1');
    expect(result.summary).toBe('过去三日整体小幅盈利');
  });
});

