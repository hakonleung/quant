import { instructionId, QuantError, type WatchTask } from '@quant/shared';

import { WatchAddInstructionHandler } from '../../../src/modules/watch/instructions/watch-add.handler.js';
import type { WatchService } from '../../../src/modules/watch/watch.service.js';
import { InstructionRegistry } from '../../../src/modules/instruction/instruction.registry.js';
import type { InstructionCtx } from '../../../src/modules/instruction/instruction.port.js';

const ctx: InstructionCtx = { traceId: 't7', source: 'im', userId: 'feishu:ou_g' };

const baseTask: WatchTask = {
  idx: 1,
  market: 'a',
  code: '600519',
  name: '贵州茅台',
  groupName: 'default',
  conditions: [{ kind: 'abs', op: 'gte', thresholdPrice: '1700.00' }],
  intervalSec: 20,
  pushIntervalSec: 300,
  remaining: null,
  notifySlack: true,
  enabled: true,
  createdAt: '2026-05-06T10:00:00.000+00:00',
  lastTickAt: null,
  lastPushAt: null,
  lastSampleAt: null,
  hitCount: 0,
  lastHitPrice: null,
};

function build(opts: {
  lookupName?: string;
  lookupReject?: Error;
  createResolve?: WatchTask;
  createReject?: Error;
}): { handler: WatchAddInstructionHandler } {
  const reg = new InstructionRegistry();
  const watch: Pick<WatchService, 'lookup' | 'create'> = {
    lookup: jest.fn().mockImplementation(() => {
      if (opts.lookupReject !== undefined) return Promise.reject(opts.lookupReject);
      return Promise.resolve({ name: opts.lookupName ?? '贵州茅台' });
    }),
    create: jest.fn().mockImplementation(() => {
      if (opts.createReject !== undefined) return Promise.reject(opts.createReject);
      return Promise.resolve(opts.createResolve ?? baseTask);
    }),
  };
  return { handler: new WatchAddInstructionHandler(reg, watch as unknown as WatchService) };
}

describe('WatchAddInstructionHandler', () => {
  it('declares spec id `watch.add` in group=watch', () => {
    const { handler } = build({});
    expect(handler.spec.id).toBe(instructionId('watch.add'));
    expect(handler.spec.group).toBe('watch');
  });

  it('golden path returns w-index and stock info', async () => {
    const { handler } = build({});
    const r = await handler.execute({ code: '600519', market: 'a', group: 'default' }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.text).toContain('w1');
      expect(r.output.text).toContain('a:600519');
      expect(r.output.text).toContain('default');
    }
  });

  it('uses provided name arg and skips lookup', async () => {
    const { handler } = build({ lookupReject: new Error('should not be called') });
    const r = await handler.execute(
      { code: '600519', market: 'a', group: 'default', name: '自定义名' },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.text).toContain('自定义名');
    }
  });

  it('falls back to code as name when lookup fails', async () => {
    const { handler } = build({ lookupReject: new Error('stock not found') });
    const r = await handler.execute({ code: '600519', market: 'a', group: 'default' }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.text).toContain('600519');
    }
  });

  it('returns errResult validation for invalid code in market', async () => {
    const { handler } = build({});
    const r = await handler.execute({ code: 'AAPL', market: 'a', group: 'default' }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('validation');
      expect(r.error.message).toContain('AAPL');
    }
  });

  it('converts QuantError from create into errResult validation', async () => {
    const { handler } = build({
      createReject: new QuantError('WATCH_TASK_CONFLICT', 'task already exists', {}),
    });
    const r = await handler.execute({ code: '600519', market: 'a', group: 'default' }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('validation');
      expect(r.error.message).toBe('task already exists');
    }
  });

  it('rethrows non-QuantError from create', async () => {
    const { handler } = build({ createReject: new Error('disk full') });
    await expect(
      handler.execute({ code: '600519', market: 'a', group: 'default' }, ctx),
    ).rejects.toThrow('disk full');
  });

  it('costsCredits is not set (watch.add is free)', () => {
    const { handler } = build({});
    expect(handler.spec.costsCredits).toBeFalsy();
  });
});
