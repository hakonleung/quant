/**
 * Tests for the /watch (list) cell — handler + renderer.
 *
 * Handler covers:
 *   - empty task list → tasks=[], stockRows=null
 *   - non-A-share-only tasks → projected tasks, stockRows=null
 *   - mixed tasks with A-share codes → assembled stockRows
 *   - StockListService failure → stockRows degrades to null
 *
 * Renderer covers:
 *   - empty tasks → "no watch tasks"
 *   - tasks without stockRows → subheader-only result
 *   - tasks with stockRows → text + stockTable* meta
 *   - error envelope passthrough
 */

import type {
  InstructionEnvelope,
  ResultOf,
  StockListRow,
  WatchTask,
} from '@quant/shared';

import { buildWatchCell } from '../../../src/modules/instruction-center/cells/watch.cell.js';
import { renderWatch } from '../../../src/modules/instruction-center/cells/watch.render.js';
import type { InstructionCtx } from '../../../src/modules/instruction/instruction.port.js';
import type { StockListService } from '../../../src/modules/stock-list/stock-list.service.js';
import type { WatchService } from '../../../src/modules/watch/watch.service.js';

type WatchListResult = ResultOf<'watch'>;

const ctx: InstructionCtx = { traceId: 't1', source: 'im', userId: 'me' };

function task(overrides: Partial<WatchTask> = {}): WatchTask {
  return {
    idx: 1,
    market: 'a',
    code: '600519',
    name: '茅台',
    groupName: 'default',
    conditions: [],
    intervalSec: 20,
    pushIntervalSec: 300,
    remaining: null,
    notifySlack: true,
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastTickAt: null,
    lastPushAt: null,
    lastSampleAt: null,
    hitCount: 0,
    lastHitPrice: null,
    ...overrides,
  } as WatchTask;
}

function fakeWatch(tasks: readonly WatchTask[]): WatchService {
  return { list: () => Promise.resolve(tasks) } as unknown as WatchService;
}

function fakeStockList(rows: StockListRow[], shouldThrow = false): StockListService {
  return {
    assembleRows: () =>
      shouldThrow
        ? Promise.reject(new Error('snapshot upstream down'))
        : Promise.resolve({ rows }),
  } as unknown as StockListService;
}

const emptyRow = (code: string): StockListRow => ({
  code,
  name: code,
  price: null,
  chgPct: null,
  turnoverRate: null,
  turnover: null,
  consecUp: null,
  ret5d: null,
  ret10d: null,
  ret20d: null,
  ret90d: null,
  ret250d: null,
  wcmi: null,
  wcmiRhythm: null,
  wcmiMaSupport: null,
  wcmiUpWave: null,
  wcmiYangDom: null,
  wcmiShadowClean: null,
  wcmiStageGain: null,
  wcmiCrashAvoid: null, wcmiRecentStrength: null,
  mktCap: null,
  floatMktCap: null,
  peTtm: null,
  peDynamic: null,
  pb: null,
  peg: null,
  grossMargin: null,
  ddeMainInflow3d: null,
  ddeMainInflow5d: null,
  ddeMainInflow10d: null,
  ddeMainInflow20d: null,
  ddeMainInflowRatio3d: null,
  ddeMainInflowRatio5d: null,
  ddeMainInflowRatio10d: null,
  ddeMainInflowRatio20d: null,
});

describe('buildWatchCell.handler', () => {
  it('returns empty result when no tasks', async () => {
    const cell = buildWatchCell({
      watch: fakeWatch([]),
      stockList: fakeStockList([]),
    });
    const r = await cell.handler({ sub: 'list' }, ctx);
    expect(r).toEqual<WatchListResult>({ tasks: [], stockRows: null });
  });

  it('projects tasks to WatchListTask shape (no scheduling internals)', async () => {
    const cell = buildWatchCell({
      watch: fakeWatch([task({ idx: 2, name: 'maotai', enabled: false, hitCount: 3 })]),
      stockList: fakeStockList([emptyRow('600519')]),
    });
    const r = await cell.handler({ sub: 'list' }, ctx);
    expect(r.tasks).toEqual([
      {
        idx: 2,
        market: 'a',
        code: '600519',
        name: 'maotai',
        groupName: 'default',
        enabled: false,
        hitCount: 3,
      },
    ]);
  });

  it('skips stock-row assembly when no A-share tasks present', async () => {
    let called = false;
    const stockList = {
      assembleRows: () => {
        called = true;
        return Promise.resolve({ rows: [] });
      },
    } as unknown as StockListService;
    const cell = buildWatchCell({
      watch: fakeWatch([task({ market: 'hk', code: '700' })]),
      stockList,
    });
    const r = await cell.handler({ sub: 'list' }, ctx);
    expect(called).toBe(false);
    expect(r.stockRows).toBeNull();
    expect(r.tasks).toHaveLength(1);
  });

  it('assembles stockRows for A-share tasks', async () => {
    const cell = buildWatchCell({
      watch: fakeWatch([task()]),
      stockList: fakeStockList([emptyRow('600519')]),
    });
    const r = await cell.handler({ sub: 'list' }, ctx);
    expect(r.stockRows).toHaveLength(1);
    expect(r.stockRows?.[0]?.code).toBe('600519');
  });

  it('degrades stockRows to null when assembleRows throws', async () => {
    const cell = buildWatchCell({
      watch: fakeWatch([task()]),
      stockList: fakeStockList([], true),
    });
    const r = await cell.handler({ sub: 'list' }, ctx);
    expect(r.stockRows).toBeNull();
    expect(r.tasks).toHaveLength(1);
  });

  it('dedupes A-share codes before fetching snapshots', async () => {
    let receivedCodes: readonly string[] = [];
    const stockList = {
      assembleRows: (args: { codes: readonly string[] }) => {
        receivedCodes = args.codes;
        return Promise.resolve({ rows: [] });
      },
    } as unknown as StockListService;
    const cell = buildWatchCell({
      watch: fakeWatch([task({ idx: 1 }), task({ idx: 2 })]),
      stockList,
    });
    await cell.handler({ sub: 'list' }, ctx);
    expect(receivedCodes).toEqual(['600519']);
  });
});

describe('renderWatch', () => {
  function okEnv(data: WatchListResult): InstructionEnvelope<WatchListResult> {
    return { ok: true, data };
  }

  it('renders "no watch tasks" on empty task list', () => {
    const out = renderWatch(okEnv({ tasks: [], stockRows: null }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output.text).toBe('no watch tasks');
  });

  it('renders subheader-only when stockRows=null', () => {
    const out = renderWatch(
      okEnv({
        tasks: [
          {
            idx: 1,
            market: 'a',
            code: '600519',
            name: 'mt',
            groupName: 'g',
            enabled: true,
            hitCount: 0,
          },
        ],
        stockRows: null,
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output.text).toContain('watch tasks (1)');
    expect(out.output.text).toContain('w1');
    expect(out.output.text).toContain('grp=g');
    expect(out.output.meta).toBeUndefined();
  });

  it('adds stockTable* meta when stockRows non-empty', () => {
    const out = renderWatch(
      okEnv({
        tasks: [
          {
            idx: 1,
            market: 'a',
            code: '600519',
            name: 'mt',
            groupName: 'g',
            enabled: true,
            hitCount: 0,
          },
        ],
        stockRows: [emptyRow('600519')],
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output.meta).toBeDefined();
    const meta = out.output.meta as {
      stockTableRows: { code: string }[];
      stockTableSubheader: string;
    };
    expect(meta.stockTableRows[0]?.code).toBe('600519');
    expect(meta.stockTableSubheader).toContain('watch tasks (1)');
  });

  it('renders "off" status and hit count', () => {
    const out = renderWatch(
      okEnv({
        tasks: [
          {
            idx: 7,
            market: 'a',
            code: '600519',
            name: 'mt',
            groupName: 'g',
            enabled: false,
            hitCount: 5,
          },
        ],
        stockRows: null,
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output.text).toContain('off');
    expect(out.output.text).toContain('hits=5');
  });

  it('passes through error envelope verbatim', () => {
    const out = renderWatch({ ok: false, error: { code: 'handler', message: 'down' } });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toEqual({ code: 'handler', message: 'down' });
  });
});
