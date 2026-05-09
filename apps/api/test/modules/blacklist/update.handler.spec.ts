import { instructionId, QuantError, type BlacklistSnapshot } from '@quant/shared';

import type { BlacklistService } from '../../../src/modules/blacklist/blacklist.service.js';
import { UpdateInstructionHandler } from '../../../src/modules/blacklist/instructions/update.handler.js';
import { InstructionRegistry } from '../../../src/modules/instruction/instruction.registry.js';
import type { InstructionCtx } from '../../../src/modules/instruction/instruction.port.js';

const ctx: InstructionCtx = { traceId: 't1', source: 'im', userId: 'feishu:ou_a' };

function build(opts: { resolve?: BlacklistSnapshot; reject?: Error }): UpdateInstructionHandler {
  const reg = new InstructionRegistry();
  const blacklist: Pick<BlacklistService, 'refresh'> = {
    refresh: () => {
      if (opts.reject !== undefined) return Promise.reject(opts.reject);
      if (opts.resolve === undefined) return Promise.reject(new Error('misconfigured'));
      return Promise.resolve(opts.resolve);
    },
  };
  return new UpdateInstructionHandler(reg, blacklist as unknown as BlacklistService);
}

const sampleSnap: BlacklistSnapshot = {
  codes: Object.freeze(['000001', '000002']),
  asof: '2026-05-09',
  universeSize: 5000,
  computedAt: '2026-05-09T00:00:00.000Z',
};

describe('UpdateInstructionHandler', () => {
  it('declares spec id `update` (sync)', () => {
    const handler = build({ resolve: sampleSnap });
    expect(handler.spec.id).toBe(instructionId('update'));
    expect(handler.spec.mode).toBeUndefined();
  });

  it('returns the snapshot summary on success', async () => {
    const handler = build({ resolve: sampleSnap });
    const r = await handler.execute({ target: 'blacklist' }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.text).toBe('updated blacklist: size=2 asof=2026-05-09 universe=5000');
    }
  });

  it('converts QuantError into errResult code=handler', async () => {
    const handler = build({
      reject: new QuantError('INTERNAL', 'upstream down', {}),
    });
    const r = await handler.execute({ target: 'blacklist' }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('handler');
      expect(r.error.message).toBe('upstream down');
    }
  });

  it('rethrows unexpected errors', async () => {
    const handler = build({ reject: new Error('weird') });
    await expect(handler.execute({ target: 'blacklist' }, ctx)).rejects.toThrow('weird');
  });
});
