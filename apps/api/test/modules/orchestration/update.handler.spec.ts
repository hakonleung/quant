import { instructionId, type ScanAccepted } from '@quant/shared';

import type { CronOrchestrator } from '../../../src/modules/orchestration/cron.orchestrator.js';
import { UpdateInstructionHandler } from '../../../src/modules/orchestration/instructions/update.handler.js';
import { InstructionRegistry } from '../../../src/modules/instruction/instruction.registry.js';
import type { InstructionCtx } from '../../../src/modules/instruction/instruction.port.js';

const ctx: InstructionCtx = { traceId: 't1', source: 'im', userId: 'feishu:ou_a' };

function build(accepted: ScanAccepted): UpdateInstructionHandler {
  const reg = new InstructionRegistry();
  const cron: Pick<CronOrchestrator, 'fireScan'> = {
    fireScan: () => accepted,
  };
  return new UpdateInstructionHandler(reg, cron as unknown as CronOrchestrator);
}

const startedAcc: ScanAccepted = {
  traceId: 't-new',
  startedAt: '2026-05-15T00:00:00.000Z',
  started: true,
};

const coalescedAcc: ScanAccepted = {
  traceId: 't-old',
  startedAt: '2026-05-15T00:00:00.000Z',
  started: false,
};

describe('UpdateInstructionHandler', () => {
  it('declares spec id `update` (sync)', () => {
    const handler = build(startedAcc);
    expect(handler.spec.id).toBe(instructionId('update'));
    expect(handler.spec.mode).toBeUndefined();
  });

  it('returns the started message when a fresh scan begins', async () => {
    const handler = build(startedAcc);
    const r = await handler.execute({}, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.text).toBe('scan started: traceId=t-new');
    }
  });

  it('returns the coalesced message when a scan is already in flight', async () => {
    const handler = build(coalescedAcc);
    const r = await handler.execute({}, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.text).toBe('scan already in flight (coalesced): traceId=t-old');
    }
  });
});
