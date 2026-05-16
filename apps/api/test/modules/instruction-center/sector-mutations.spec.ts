/**
 * Tests for the three sector mutation cells
 * (`sector.publish` / `sector.unpublish` / `sector.rm`) + the shared
 * `renderSectorAck` renderer.
 *
 * Handler coverage:
 *   - golden path returns { id, action } with the right verb
 *   - QuantError(FORBIDDEN) → InstructionDispatchError('forbidden')
 *   - QuantError(NOT_FOUND) → InstructionDispatchError('not-found')
 *   - unrelated throws propagate untouched
 *
 * Renderer coverage:
 *   - one-line text per action (published / unpublished / deleted)
 *   - error envelope passthrough
 */

import {
  QuantError,
  type InstructionEnvelope,
  type SectorAckResult,
} from '@quant/shared';

import { renderSectorAck } from '../../../src/modules/instruction-center/cells/sector-ack.render.js';
import {
  buildSectorPublishCell,
  buildSectorUnpublishCell,
  mapSectorMutationError,
} from '../../../src/modules/instruction-center/cells/sector-publish.cell.js';
import { buildSectorRmCell } from '../../../src/modules/instruction-center/cells/sector-rm.cell.js';
import type { InstructionCtx } from '../../../src/modules/instruction/instruction.port.js';
import type { SectorsService } from '../../../src/modules/sectors/sectors.service.js';

const ctx: InstructionCtx = { traceId: 't1', source: 'im', userId: 'me' };

interface FakeSectorsOpts {
  readonly setPublishedReject?: Error;
  readonly removeReject?: Error;
}

interface SetPublishedCall {
  userId: string;
  id: string;
  publish: boolean;
}

interface RemoveCall {
  userId: string;
  id: string;
}

function fakeSectors(opts: FakeSectorsOpts = {}): {
  service: SectorsService;
  setPublishedCalls: SetPublishedCall[];
  removeCalls: RemoveCall[];
} {
  const setPublishedCalls: SetPublishedCall[] = [];
  const removeCalls: RemoveCall[] = [];
  const service = {
    setPublished: (userId: string, id: string, publish: boolean) => {
      setPublishedCalls.push({ userId, id, publish });
      if (opts.setPublishedReject !== undefined) return Promise.reject(opts.setPublishedReject);
      return Promise.resolve();
    },
    remove: (userId: string, id: string) => {
      removeCalls.push({ userId, id });
      if (opts.removeReject !== undefined) return Promise.reject(opts.removeReject);
      return Promise.resolve();
    },
  } as unknown as SectorsService;
  return { service, setPublishedCalls, removeCalls };
}

describe('buildSectorPublishCell.handler', () => {
  it('publishes the sector and returns action=published', async () => {
    const { service, setPublishedCalls } = fakeSectors();
    const cell = buildSectorPublishCell({ sectors: service });
    const r = await cell.handler({ id: 's1' }, ctx);
    expect(r).toEqual<SectorAckResult>({ id: 's1', action: 'published' });
    expect(setPublishedCalls).toEqual([{ userId: 'me', id: 's1', publish: true }]);
  });

  it('maps QuantError(FORBIDDEN) → InstructionDispatchError(forbidden)', async () => {
    const cell = buildSectorPublishCell({
      sectors: fakeSectors({
        setPublishedReject: new QuantError('FORBIDDEN', 'not your sector', {}),
      }).service,
    });
    await expect(cell.handler({ id: 's1' }, ctx)).rejects.toMatchObject({
      name: 'InstructionDispatchError',
      code: 'forbidden',
    });
  });

  it('maps QuantError(NOT_FOUND) → InstructionDispatchError(not-found)', async () => {
    const cell = buildSectorPublishCell({
      sectors: fakeSectors({
        setPublishedReject: new QuantError('NOT_FOUND', 'unknown sector', {}),
      }).service,
    });
    await expect(cell.handler({ id: 'ghost' }, ctx)).rejects.toMatchObject({
      name: 'InstructionDispatchError',
      code: 'not-found',
    });
  });
});

describe('buildSectorUnpublishCell.handler', () => {
  it('unpublishes the sector and returns action=unpublished', async () => {
    const { service, setPublishedCalls } = fakeSectors();
    const cell = buildSectorUnpublishCell({ sectors: service });
    const r = await cell.handler({ id: 's1' }, ctx);
    expect(r).toEqual<SectorAckResult>({ id: 's1', action: 'unpublished' });
    expect(setPublishedCalls).toEqual([{ userId: 'me', id: 's1', publish: false }]);
  });

  it('propagates non-QuantError throws untouched', async () => {
    const cell = buildSectorUnpublishCell({
      sectors: fakeSectors({ setPublishedReject: new Error('disk full') }).service,
    });
    await expect(cell.handler({ id: 's1' }, ctx)).rejects.toThrow('disk full');
  });
});

describe('buildSectorRmCell.handler', () => {
  it('removes the sector and returns action=deleted', async () => {
    const { service, removeCalls } = fakeSectors();
    const cell = buildSectorRmCell({ sectors: service });
    const r = await cell.handler({ id: 's1' }, ctx);
    expect(r).toEqual<SectorAckResult>({ id: 's1', action: 'deleted' });
    expect(removeCalls).toEqual([{ userId: 'me', id: 's1' }]);
  });

  it('maps QuantError(NOT_FOUND) → InstructionDispatchError(not-found)', async () => {
    const cell = buildSectorRmCell({
      sectors: fakeSectors({
        removeReject: new QuantError('NOT_FOUND', 'gone', {}),
      }).service,
    });
    await expect(cell.handler({ id: 's1' }, ctx)).rejects.toMatchObject({
      name: 'InstructionDispatchError',
      code: 'not-found',
    });
  });

  it('maps QuantError(FORBIDDEN) → InstructionDispatchError(forbidden)', async () => {
    const cell = buildSectorRmCell({
      sectors: fakeSectors({
        removeReject: new QuantError('FORBIDDEN', 'not yours', {}),
      }).service,
    });
    await expect(cell.handler({ id: 's1' }, ctx)).rejects.toMatchObject({
      name: 'InstructionDispatchError',
      code: 'forbidden',
    });
  });
});

describe('mapSectorMutationError', () => {
  it('passes through unknown QuantError codes untouched (executor wraps to handler)', () => {
    const e = new QuantError('LLM_FAILED', 'boom', {});
    expect(mapSectorMutationError(e)).toBe(e);
  });

  it('passes through non-QuantError throws untouched', () => {
    const e = new Error('disk full');
    expect(mapSectorMutationError(e)).toBe(e);
  });
});

describe('renderSectorAck', () => {
  function okEnv(data: SectorAckResult): InstructionEnvelope<SectorAckResult> {
    return { ok: true, data };
  }

  it('emits "published s1" for action=published', () => {
    const out = renderSectorAck(okEnv({ id: 's1', action: 'published' }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output.text).toBe('published s1');
  });

  it('emits "unpublished s2" for action=unpublished', () => {
    const out = renderSectorAck(okEnv({ id: 's2', action: 'unpublished' }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output.text).toBe('unpublished s2');
  });

  it('emits "deleted s3" for action=deleted', () => {
    const out = renderSectorAck(okEnv({ id: 's3', action: 'deleted' }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output.text).toBe('deleted s3');
  });

  it('passes through error envelope verbatim', () => {
    const out = renderSectorAck({
      ok: false,
      error: { code: 'forbidden', message: 'not yours' },
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toEqual({ code: 'forbidden', message: 'not yours' });
  });
});
