import { CronOrchestrator } from '../../../src/modules/orchestration/cron.orchestrator.js';

function queue(added: string[]): { addBulk(items: readonly unknown[]): number } {
  return {
    addBulk: (items) => {
      added.push(...items.map(() => 'job'));
      return items.length;
    },
  };
}

describe('CronOrchestrator batch lifecycle', () => {
  it('coalesces scans until queue settlement completes', async () => {
    let settle = (): void => undefined;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const inspector = {
      syncStockMetaFull: () => Promise.resolve({ fetched: 5512, updated: 1 }),
      syncBulkFinancials: () => Promise.resolve({ fetched: 5512, updated: 1 }),
      findMetaWork: () => Promise.resolve([]),
      findStaleKline: () => Promise.resolve([]),
    };
    const queue = { addBulk: () => 0 };
    const settler = { register: () => settled };
    const cron = new CronOrchestrator(
      queue as never,
      queue as never,
      inspector as never,
      settler as never,
    );

    const first = cron.triggerScan('trace-1');
    await Promise.resolve();
    const second = cron.triggerScan('trace-2');

    const observed = [second === first, cron.isScanning()];
    settle();
    await first;
    observed.push(cron.isScanning());
    expect(observed).toEqual([true, true, false]);
  });

  it('does not enqueue either branch when one inspection fails', async () => {
    const added: string[] = [];
    const inspector = {
      syncStockMetaFull: () => Promise.resolve({ fetched: 5512, updated: 0 }),
      syncBulkFinancials: () => Promise.resolve({ fetched: 5512, updated: 0 }),
      findMetaWork: () =>
        Promise.resolve([{ code: '600519', needBasic: true, needFinancials: false }]),
      findStaleKline: () => Promise.reject(new Error('watermark read failed')),
    };
    const settler = { register: () => Promise.resolve() };
    const cron = new CronOrchestrator(
      queue(added) as never,
      queue(added) as never,
      inspector as never,
      settler as never,
    );

    let message = '';
    try {
      await cron.triggerScan('trace-failed-inspection');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect({ added, message }).toEqual({ added: [], message: 'watermark read failed' });
  });

  it('aborts before inspection and enqueue when full meta sync fails', async () => {
    const calls: string[] = [];
    const inspector = {
      syncStockMetaFull: () => {
        calls.push('full');
        return Promise.reject(new Error('meta source down'));
      },
      syncBulkFinancials: () => {
        calls.push('financials');
        return Promise.resolve({ fetched: 0, updated: 0 });
      },
      findMetaWork: () => {
        calls.push('meta');
        return Promise.resolve([]);
      },
      findStaleKline: () => {
        calls.push('kline');
        return Promise.resolve([]);
      },
    };
    const cron = new CronOrchestrator(
      queue(calls) as never,
      queue(calls) as never,
      inspector as never,
      { register: () => Promise.resolve() } as never,
    );

    let message = '';
    try {
      await cron.triggerScan('trace-full-fail');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect({ calls, message }).toEqual({ calls: ['full'], message: 'meta source down' });
  });
});
