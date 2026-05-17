/**
 * Tests for BacktestService.
 *
 * Strategy: fake the Flight client + KlineReader + ScreenExec so the
 * service is exercised in pure NestJS isolation. We assert two things:
 *   1. The Flight `args` we send to Python are correctly assembled from
 *      caller-supplied signals + locally-fetched klines.
 *   2. The Python payload is parsed back through the shared zod schema.
 */

import type { ScreenRow } from '../../../src/modules/screen/domain/pure/screen-eval.js';
import type { FlightClient } from '../../../src/adapters/flight/flight-client.js';
import type { KlineReaderService } from '../../../src/modules/kline/kline-reader.service.js';
import type { ScreenExecService } from '../../../src/modules/screen/screen-exec.service.js';
import { BacktestService } from '../../../src/modules/backtest/backtest.service.js';
import type {
  BacktestEvaluateScreenRequest,
  BacktestEvaluateSignalsRequest,
  ScreenPlanAst,
  ScreenRunResult,
  UniversePlanAst,
} from '@quant/shared';

// ---- fakes ----

interface FakeProxy {
  toJSON(): Record<string, unknown>;
}

class FakeTable {
  constructor(private readonly rows: readonly Record<string, unknown>[]) {}
  get numRows(): number {
    return this.rows.length;
  }
  get(i: number): FakeProxy | null {
    const row = this.rows[i];
    if (row === undefined) return null;
    return { toJSON: () => row };
  }
}

interface FlightCall {
  op: string;
  args: Record<string, unknown>;
}

function fakeFlight(payload: object): {
  client: FlightClient;
  calls: FlightCall[];
} {
  const calls: FlightCall[] = [];
  const table = new FakeTable([{ payload_json: JSON.stringify(payload) }]);
  const client = {
    // eslint-disable-next-line @typescript-eslint/require-await
    doGet: async (
      op: string,
      args: Record<string, unknown>,
      _opts: unknown,
    ): Promise<{ value: FakeTable }> => {
      calls.push({ op, args });
      return { value: table };
    },
  } as unknown as FlightClient;
  return { client, calls };
}

interface KlineFake {
  reader: KlineReaderService;
  readonly lastRange: { start: Date; end: Date } | null;
}

function fakeKline(rowsByCode: Record<string, ScreenRow[]>): KlineFake {
  const ref: { lastRange: { start: Date; end: Date } | null } = { lastRange: null };
  const reader = {
    // eslint-disable-next-line @typescript-eslint/require-await
    bulkRangeForScreen: async (
      codes: readonly string[],
      start: Date,
      end: Date,
    ): Promise<Record<string, readonly ScreenRow[]>> => {
      ref.lastRange = { start, end };
      const out: Record<string, readonly ScreenRow[]> = {};
      for (const c of codes) {
        const rows = rowsByCode[c];
        if (rows !== undefined) out[c] = rows;
      }
      return out;
    },
  } as unknown as KlineReaderService;
  return {
    reader,
    get lastRange() {
      return ref.lastRange;
    },
  };
}

function fakeScreenExec(
  matchesByAsof: Record<string, string[]>,
): { exec: ScreenExecService; calls: string[] } {
  const calls: string[] = [];
  const exec = {
    // eslint-disable-next-line @typescript-eslint/require-await
    execute: async (plan: ScreenPlanAst): Promise<ScreenRunResult> => {
      calls.push(plan.asof);
      const codes = matchesByAsof[plan.asof] ?? [];
      return {
        matches: codes.map((c) => ({ code: c, evidence: {} })),
        planSignature: 'sig',
      };
    },
  } as unknown as ScreenExecService;
  return { exec, calls };
}

function row(date: string, openQfq: number): ScreenRow {
  return {
    trade_date: date,
    open_qfq: openQfq,
    high_qfq: openQfq,
    low_qfq: openQfq,
    close_qfq: openQfq,
    volume: 100,
    amount: 100,
    turnover_rate: 0.01,
    ma5: null,
    ma10: null,
    ma20: null,
    ma60: null,
    pct_chg_qfq: null,
  };
}

const VALID_PAYLOAD = {
  holdings: [5, 10],
  signalDateRange: ['2024-01-02', '2024-01-02'],
  universeSizeAvg: 1.0,
  observations: [
    {
      signalDate: '2024-01-02',
      code: '000001',
      holding: 5,
      entryDate: '2024-01-03',
      entryPx: 10,
      exitDate: '2024-01-10',
      exitPx: 11,
      ret: 0.1,
    },
  ],
  summary: [
    {
      holding: 5,
      n: 1,
      mean: 0.1,
      median: 0.1,
      std: 0,
      p05: 0.1,
      p25: 0.1,
      p75: 0.1,
      p95: 0.1,
      winRate: 1.0,
      sharpeLike: 0,
    },
    {
      holding: 10,
      n: 0,
      mean: 0,
      median: 0,
      std: 0,
      p05: 0,
      p25: 0,
      p75: 0,
      p95: 0,
      winRate: 0,
      sharpeLike: 0,
    },
  ],
};

// ---- evaluate_signals ----

describe('BacktestService.evaluateSignals', () => {
  it('ships unique codes + fetched bars to the Python op', async () => {
    const { client, calls } = fakeFlight(VALID_PAYLOAD);
    const klineFake = fakeKline({
      '000001': [row('2024-01-02', 10), row('2024-01-03', 11)],
      '000002': [row('2024-01-02', 20), row('2024-01-03', 21)],
    });
    const screenFake = fakeScreenExec({});
    const svc = new BacktestService(client, klineFake.reader, screenFake.exec);

    const req: BacktestEvaluateSignalsRequest = {
      signals: [
        { signalDate: '2024-01-02', code: '000001' },
        { signalDate: '2024-01-02', code: '000002' },
        // duplicate code on same day → still 2 unique codes
        { signalDate: '2024-01-02', code: '000001' },
      ],
      holdings: [5, 10],
    };
    const result = await svc.evaluateSignals(req, 'trace-1');

    expect(result.summary).toHaveLength(2);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.op).toBe('evaluate_signal');
    expect(call.args['holdings']).toEqual([5, 10]);
    const klines = call.args['klines'] as Record<
      string,
      { trade_date: string[]; open_qfq: number[] }
    >;
    expect(Object.keys(klines).sort()).toEqual(['000001', '000002']);
    expect(klines['000001']?.trade_date).toEqual(['2024-01-02', '2024-01-03']);
    expect(klines['000001']?.open_qfq).toEqual([10, 11]);
  });

  it('extends kline upper bound by max(holding) * 1.6 + buffer calendar days', async () => {
    const { client } = fakeFlight(VALID_PAYLOAD);
    const klineFake = fakeKline({ '000001': [row('2024-01-02', 10)] });
    const screenFake = fakeScreenExec({});
    const svc = new BacktestService(client, klineFake.reader, screenFake.exec);

    await svc.evaluateSignals(
      {
        signals: [{ signalDate: '2024-01-02', code: '000001' }],
        holdings: [10],
      },
      'trace-1',
    );
    expect(klineFake.lastRange).not.toBeNull();
    const range = klineFake.lastRange!;
    expect(range.start.toISOString().slice(0, 10)).toBe('2024-01-02');
    // 10 * 1.6 + 10 = 26 calendar days forward from 2024-01-02
    // eslint-disable-next-line no-restricted-globals -- pure UTC arithmetic, no clock
    const expectedEndMs = Date.UTC(2024, 0, 2) + 26 * 86_400_000;
    expect(range.end.getTime()).toBe(expectedEndMs);
  });

  it('skips codes for which kline reader returned no bars', async () => {
    const { client, calls } = fakeFlight(VALID_PAYLOAD);
    const klineFake = fakeKline({ '000001': [row('2024-01-02', 10)] });
    const screenFake = fakeScreenExec({});
    const svc = new BacktestService(client, klineFake.reader, screenFake.exec);

    await svc.evaluateSignals(
      {
        signals: [
          { signalDate: '2024-01-02', code: '000001' },
          { signalDate: '2024-01-02', code: '999999' }, // no klines
        ],
        holdings: [5],
      },
      'trace-1',
    );
    const klines = calls[0]!.args['klines'] as Record<string, unknown>;
    expect(Object.keys(klines)).toEqual(['000001']);
  });

  it('throws when the Flight response carries no payload', async () => {
    const fake = {
      client: {
        // eslint-disable-next-line @typescript-eslint/require-await
        doGet: async (): Promise<{ value: FakeTable }> => ({ value: new FakeTable([]) }),
      } as unknown as FlightClient,
    };
    const klineFake = fakeKline({ '000001': [row('2024-01-02', 10)] });
    const screenFake = fakeScreenExec({});
    const svc = new BacktestService(fake.client, klineFake.reader, screenFake.exec);

    await expect(
      svc.evaluateSignals(
        {
          signals: [{ signalDate: '2024-01-02', code: '000001' }],
          holdings: [5],
        },
        'trace-1',
      ),
    ).rejects.toThrow(/no payload/);
  });
});

// ---- evaluate_screen ----

describe('BacktestService.evaluateScreen', () => {
  const plan: ScreenPlanAst = {
    asof: '2024-01-01', // overridden per-day by the service
    expr: { kind: 'all', preds: [] },
  } as unknown as ScreenPlanAst;
  const universe: UniversePlanAst | null = null;

  it('runs the screen for each weekday in [start,end] and skips weekends', async () => {
    const { client } = fakeFlight(VALID_PAYLOAD);
    const klineFake = fakeKline({ '000001': [row('2024-01-02', 10)] });
    // 2024-01-02 (Tue) → match; 2024-01-03 (Wed) → no matches; 2024-01-04 (Thu) → match
    // 2024-01-06/07 weekend skipped entirely
    const screenFake = fakeScreenExec({
      '2024-01-02': ['000001'],
      '2024-01-03': [],
      '2024-01-04': ['000001'],
    });
    const svc = new BacktestService(client, klineFake.reader, screenFake.exec);

    const req: BacktestEvaluateScreenRequest = {
      screenPlan: plan,
      universePlan: universe,
      rank: null,
      startDate: '2024-01-02', // Tue
      endDate: '2024-01-07', // Sun
      holdings: [5, 10],
    };
    await svc.evaluateScreen(req, 'trace-1');
    expect(screenFake.calls).toEqual(['2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05']);
  });

  it('returns the empty-summary skeleton when no day produces matches', async () => {
    const { client, calls } = fakeFlight(VALID_PAYLOAD);
    const klineFake = fakeKline({});
    const screenFake = fakeScreenExec({
      '2024-01-02': [],
      '2024-01-03': [],
    });
    const svc = new BacktestService(client, klineFake.reader, screenFake.exec);

    const res = await svc.evaluateScreen(
      {
        screenPlan: plan,
        universePlan: universe,
        rank: null,
        startDate: '2024-01-02',
        endDate: '2024-01-03',
        holdings: [5, 10],
      },
      'trace-1',
    );
    // No Flight call when there are zero signals — the empty skeleton is local.
    expect(calls).toHaveLength(0);
    expect(res.holdings).toEqual([5, 10]);
    expect(res.signalDateRange).toBeNull();
    expect(res.summary.every((s) => s.n === 0)).toBe(true);
  });

  it('rejects startDate > endDate', async () => {
    const { client } = fakeFlight(VALID_PAYLOAD);
    const klineFake = fakeKline({});
    const screenFake = fakeScreenExec({});
    const svc = new BacktestService(client, klineFake.reader, screenFake.exec);

    await expect(
      svc.evaluateScreen(
        {
          screenPlan: plan,
          universePlan: universe,
          rank: null,
          startDate: '2024-01-10',
          endDate: '2024-01-02',
          holdings: [5],
        },
        'trace-1',
      ),
    ).rejects.toThrow(/startDate/);
  });
});
