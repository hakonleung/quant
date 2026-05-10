import { instructionId, type WatchTask } from '@quant/shared';

import { WatchRemoveInstructionHandler } from '../../../src/modules/watch/instructions/watch-remove.handler.js';
import type { WatchTaskStore } from '../../../src/modules/watch/watch-task.store.js';
import { InstructionRegistry } from '../../../src/modules/instruction/instruction.registry.js';
import type { InstructionCtx } from '../../../src/modules/instruction/instruction.port.js';

const ctx: InstructionCtx = { traceId: 't8', source: 'im', userId: 'feishu:ou_h' };

const removedTask: WatchTask = {
  idx: 3,
  market: 'a',
  code: '000858',
  name: '五粮液',
  groupName: 'default',
  conditions: [{ kind: 'abs', op: 'gte', thresholdPrice: '200.00' }],
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

function build(opts: { deleteResult: WatchTask | undefined }): {
  handler: WatchRemoveInstructionHandler;
} {
  const reg = new InstructionRegistry();
  const taskStore: Pick<WatchTaskStore, 'deleteByIdx'> = {
    deleteByIdx: jest.fn().mockResolvedValue(opts.deleteResult),
  };
  return {
    handler: new WatchRemoveInstructionHandler(reg, taskStore as unknown as WatchTaskStore),
  };
}

describe('WatchRemoveInstructionHandler', () => {
  it('declares spec id `watch.remove` in group=watch', () => {
    const { handler } = build({ deleteResult: removedTask });
    expect(handler.spec.id).toBe(instructionId('watch.remove'));
    expect(handler.spec.group).toBe('watch');
  });

  it('golden path returns removal confirmation with market:code and name', async () => {
    const { handler } = build({ deleteResult: removedTask });
    const r = await handler.execute({ id: 'w3' }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.text).toContain('w3');
      expect(r.output.text).toContain('a:000858');
      expect(r.output.text).toContain('五粮液');
    }
  });

  it('accepts bare number id without leading w', async () => {
    const { handler } = build({ deleteResult: removedTask });
    const r = await handler.execute({ id: '3' }, ctx);
    expect(r.ok).toBe(true);
  });

  it('returns errResult not-found when task does not exist', async () => {
    const { handler } = build({ deleteResult: undefined });
    const r = await handler.execute({ id: 'w99' }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('not-found');
      expect(r.error.message).toContain('w99');
    }
  });

  it('returns errResult validation for non-integer id', async () => {
    const { handler } = build({ deleteResult: undefined });
    const r = await handler.execute({ id: 'wabc' }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('validation');
      expect(r.error.message).toContain('wabc');
    }
  });

  it('returns errResult validation for zero id', async () => {
    const { handler } = build({ deleteResult: undefined });
    const r = await handler.execute({ id: 'w0' }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('validation');
    }
  });

  it('returns errResult validation for negative id', async () => {
    const { handler } = build({ deleteResult: undefined });
    const r = await handler.execute({ id: '-1' }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('validation');
    }
  });

  it('costsCredits is not set (watch.remove is free)', () => {
    const { handler } = build({ deleteResult: undefined });
    expect(handler.spec.costsCredits).toBeFalsy();
  });
});
