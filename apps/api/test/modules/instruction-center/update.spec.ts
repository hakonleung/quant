/**
 * Tests for the /update cell — handler + renderer.
 *
 * Handler: forwards `CronOrchestrator.fireScan` result verbatim.
 * Renderer: "scan started" vs "scan already in flight (coalesced)"
 * wording per the `started` flag.
 */

import type { InstructionEnvelope, ResultOf } from '@quant/shared';

import { buildUpdateCell } from '../../../src/modules/instruction-center/cells/update.cell.js';
import { renderUpdate } from '../../../src/modules/instruction-center/cells/update.render.js';
import type { InstructionCtx } from '../../../src/modules/instruction/instruction.port.js';
import type { CronOrchestrator } from '../../../src/modules/orchestration/cron.orchestrator.js';

type UpdateResult = ResultOf<'update'>;

const ctx: InstructionCtx = { traceId: 't1', source: 'im', userId: 'me' };

function fakeCron(result: { started: boolean; traceId: string }): CronOrchestrator {
  return { fireScan: () => result } as unknown as CronOrchestrator;
}

describe('buildUpdateCell.handler', () => {
  it('returns { started, traceId } from CronOrchestrator.fireScan', async () => {
    const cell = buildUpdateCell({
      cron: fakeCron({ started: true, traceId: 'trace-1' }),
    });
    const r = await cell.handler({}, ctx);
    expect(r).toEqual<UpdateResult>({ started: true, traceId: 'trace-1' });
  });

  it('preserves started=false (coalesced) traceId', async () => {
    const cell = buildUpdateCell({
      cron: fakeCron({ started: false, traceId: 'inflight-trace' }),
    });
    const r = await cell.handler({}, ctx);
    expect(r).toEqual<UpdateResult>({ started: false, traceId: 'inflight-trace' });
  });
});

describe('renderUpdate', () => {
  function okEnv(d: UpdateResult): InstructionEnvelope<UpdateResult> {
    return { ok: true, data: d };
  }

  it('emits "scan started" when started=true', () => {
    const out = renderUpdate(okEnv({ started: true, traceId: 'abc' }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output.text).toBe('scan started: traceId=abc');
  });

  it('emits "(coalesced)" when started=false', () => {
    const out = renderUpdate(okEnv({ started: false, traceId: 'xyz' }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output.text).toBe('scan already in flight (coalesced): traceId=xyz');
  });

  it('passes through error envelope', () => {
    const out = renderUpdate({ ok: false, error: { code: 'handler', message: 'cron down' } });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('handler');
  });
});
