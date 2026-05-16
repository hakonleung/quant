/**
 * Tests for the three watch mutation cells (watch.add / watch.remove /
 * watch.group) — handler + renderer per cell.
 *
 * watch.add:
 *   - valid code → task created, name resolved via lookup
 *   - lookup throws → falls back to args.code as the display name
 *   - explicit name in args overrides lookup
 *   - isValidWatchCode fails → InstructionDispatchError('validation')
 *   - QuantError on create → InstructionDispatchError('validation')
 *
 * watch.remove:
 *   - "w1" / "W2" / "3" all parse to the matching idx
 *   - non-numeric → validation
 *   - 0 or negative → validation
 *   - deleteByIdx returns undefined → not-found
 *
 * watch.group:
 *   - on → enabled=true requested='on'
 *   - resume → enabled=true requested='resume'
 *   - off → enabled=false requested='off'
 *   - patchGroup throws → not-found
 *
 * Renderers: one-line ack per cell, error envelope passthrough.
 */

import {
  QuantError,
  type InstructionEnvelope,
  type WatchAddResult,
  type WatchGroupResult,
  type WatchRemoveResult,
  type WatchTask,
} from '@quant/shared';

import {
  buildWatchAddCell,
  renderWatchAdd,
} from '../../../src/modules/instruction-center/cells/watch-add.cell.js';
import {
  buildWatchGroupCell,
  renderWatchGroup,
} from '../../../src/modules/instruction-center/cells/watch-group.cell.js';
import {
  buildWatchRemoveCell,
  renderWatchRemove,
} from '../../../src/modules/instruction-center/cells/watch-remove.cell.js';
import type { InstructionCtx } from '../../../src/modules/instruction/instruction.port.js';
import type { WatchTaskStore } from '../../../src/modules/watch/watch-task.store.js';
import type { WatchService } from '../../../src/modules/watch/watch.service.js';

const ctx: InstructionCtx = { traceId: 't1', source: 'im', userId: 'me' };

function watchTask(idx: number): WatchTask {
  return {
    idx,
    market: 'a',
    code: '600519',
    name: '茅台',
    groupName: 'daily',
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
  } as WatchTask;
}

// ── watch.add ───────────────────────────────────────────────────────────

interface FakeWatchAddOpts {
  readonly lookupResult?: { name: string };
  readonly lookupThrows?: boolean;
  readonly createReject?: Error;
}

function fakeWatchForAdd(opts: FakeWatchAddOpts = {}): {
  service: WatchService;
  createCalls: { userId: string; payload: { code: string; market: string; name: string; groupName: string } }[];
} {
  const createCalls: { userId: string; payload: { code: string; market: string; name: string; groupName: string } }[] = [];
  const service = {
    lookup: () =>
      opts.lookupThrows === true
        ? Promise.reject(new Error('lookup down'))
        : Promise.resolve(opts.lookupResult ?? { name: '茅台' }),
    create: (userId: string, payload: { code: string; market: string; name: string; groupName: string }) => {
      createCalls.push({ userId, payload });
      if (opts.createReject !== undefined) return Promise.reject(opts.createReject);
      return Promise.resolve(watchTask(7));
    },
  } as unknown as WatchService;
  return { service, createCalls };
}

describe('buildWatchAddCell.handler', () => {
  it('creates the task and returns the assigned idx + projected fields', async () => {
    const { service } = fakeWatchForAdd();
    const cell = buildWatchAddCell({ watch: service });
    const r = await cell.handler(
      { code: '600519', market: 'a', group: 'daily' },
      ctx,
    );
    expect(r).toEqual<WatchAddResult>({
      idx: 7,
      market: 'a',
      code: '600519',
      name: '茅台',
      groupName: 'daily',
    });
  });

  it('falls back to args.code as name when lookup throws', async () => {
    const { service } = fakeWatchForAdd({ lookupThrows: true });
    const cell = buildWatchAddCell({ watch: service });
    const r = await cell.handler(
      { code: '600519', market: 'a', group: 'daily' },
      ctx,
    );
    expect(r.name).toBe('600519');
  });

  it('respects an explicit name from args (no lookup)', async () => {
    let lookupCalled = false;
    const service = {
      lookup: () => {
        lookupCalled = true;
        return Promise.resolve({ name: 'should-not-be-used' });
      },
      create: () => Promise.resolve(watchTask(1)),
    } as unknown as WatchService;
    const cell = buildWatchAddCell({ watch: service });
    const r = await cell.handler(
      { code: '600519', market: 'a', group: 'daily', name: 'my-label' },
      ctx,
    );
    expect(r.name).toBe('my-label');
    expect(lookupCalled).toBe(false);
  });

  it('throws InstructionDispatchError(validation) on invalid market code combo', async () => {
    const { service } = fakeWatchForAdd();
    const cell = buildWatchAddCell({ watch: service });
    await expect(
      cell.handler({ code: 'XX', market: 'a', group: 'daily' }, ctx),
    ).rejects.toMatchObject({ name: 'InstructionDispatchError', code: 'validation' });
  });

  it('maps QuantError on create → InstructionDispatchError(validation)', async () => {
    const { service } = fakeWatchForAdd({
      createReject: new QuantError('INVALID_ARGUMENT', 'group missing', {}),
    });
    const cell = buildWatchAddCell({ watch: service });
    await expect(
      cell.handler({ code: '600519', market: 'a', group: 'unknown' }, ctx),
    ).rejects.toMatchObject({ name: 'InstructionDispatchError', code: 'validation' });
  });

  it('propagates unrelated throws untouched', async () => {
    const { service } = fakeWatchForAdd({ createReject: new Error('disk full') });
    const cell = buildWatchAddCell({ watch: service });
    await expect(
      cell.handler({ code: '600519', market: 'a', group: 'daily' }, ctx),
    ).rejects.toThrow('disk full');
  });
});

describe('renderWatchAdd', () => {
  function okEnv(d: WatchAddResult): InstructionEnvelope<WatchAddResult> {
    return { ok: true, data: d };
  }

  it('emits one-line ack with w-index, market:code, name, group', () => {
    const out = renderWatchAdd(
      okEnv({ idx: 5, market: 'a', code: '600519', name: '茅台', groupName: 'daily' }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output.text).toBe('w5 added: a:600519 "茅台" in group daily');
  });

  it('passes through error envelope', () => {
    const out = renderWatchAdd({ ok: false, error: { code: 'validation', message: 'bad' } });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('validation');
  });
});

// ── watch.remove ────────────────────────────────────────────────────────

interface FakeStoreOpts {
  readonly returnedIdx?: number | undefined;
}

function fakeStore(opts: FakeStoreOpts = {}): {
  store: WatchTaskStore;
  calls: { userId: string; idx: number }[];
} {
  const calls: { userId: string; idx: number }[] = [];
  const store = {
    deleteByIdx: (userId: string, idx: number) => {
      calls.push({ userId, idx });
      if (opts.returnedIdx === undefined) return Promise.resolve(undefined);
      return Promise.resolve(watchTask(opts.returnedIdx));
    },
  } as unknown as WatchTaskStore;
  return { store, calls };
}

describe('buildWatchRemoveCell.handler', () => {
  it('parses "w1" to idx=1 and returns the removed idx', async () => {
    const { store, calls } = fakeStore({ returnedIdx: 1 });
    const cell = buildWatchRemoveCell({ taskStore: store });
    const r = await cell.handler({ id: 'w1' }, ctx);
    expect(r).toEqual<WatchRemoveResult>({ idx: 1 });
    expect(calls).toEqual([{ userId: 'me', idx: 1 }]);
  });

  it('accepts uppercase "W2"', async () => {
    const { store, calls } = fakeStore({ returnedIdx: 2 });
    const cell = buildWatchRemoveCell({ taskStore: store });
    await cell.handler({ id: 'W2' }, ctx);
    expect(calls[0]?.idx).toBe(2);
  });

  it('accepts bare numeric "3"', async () => {
    const { store, calls } = fakeStore({ returnedIdx: 3 });
    const cell = buildWatchRemoveCell({ taskStore: store });
    await cell.handler({ id: '3' }, ctx);
    expect(calls[0]?.idx).toBe(3);
  });

  it('rejects non-numeric ids with validation', async () => {
    const { store } = fakeStore();
    const cell = buildWatchRemoveCell({ taskStore: store });
    await expect(cell.handler({ id: 'abc' }, ctx)).rejects.toMatchObject({
      name: 'InstructionDispatchError',
      code: 'validation',
    });
  });

  it('rejects 0 and negative ids with validation', async () => {
    const { store } = fakeStore();
    const cell = buildWatchRemoveCell({ taskStore: store });
    await expect(cell.handler({ id: '0' }, ctx)).rejects.toMatchObject({
      name: 'InstructionDispatchError',
      code: 'validation',
    });
  });

  it('returns not-found when the store says no such idx', async () => {
    const { store } = fakeStore({ returnedIdx: undefined });
    const cell = buildWatchRemoveCell({ taskStore: store });
    await expect(cell.handler({ id: 'w9' }, ctx)).rejects.toMatchObject({
      name: 'InstructionDispatchError',
      code: 'not-found',
    });
  });
});

describe('renderWatchRemove', () => {
  it('emits "removed w5"', () => {
    const out = renderWatchRemove({ ok: true, data: { idx: 5 } });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output.text).toBe('removed w5');
  });

  it('passes through error envelope', () => {
    const out = renderWatchRemove({
      ok: false,
      error: { code: 'not-found', message: 'gone' },
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('not-found');
  });
});

// ── watch.group ─────────────────────────────────────────────────────────

interface FakeWatchGroupOpts {
  readonly enabledAfter?: boolean;
  readonly patchReject?: Error;
}

function fakeWatchForGroup(opts: FakeWatchGroupOpts = {}): {
  service: WatchService;
  calls: { userId: string; name: string; patch: { enabled: boolean } }[];
} {
  const calls: { userId: string; name: string; patch: { enabled: boolean } }[] = [];
  const service = {
    patchGroup: (userId: string, name: string, patch: { enabled: boolean }) => {
      calls.push({ userId, name, patch });
      if (opts.patchReject !== undefined) return Promise.reject(opts.patchReject);
      return Promise.resolve({ name, enabled: opts.enabledAfter ?? patch.enabled });
    },
  } as unknown as WatchService;
  return { service, calls };
}

describe('buildWatchGroupCell.handler', () => {
  it('on → enabled=true, requestedState=on', async () => {
    const { service, calls } = fakeWatchForGroup();
    const cell = buildWatchGroupCell({ watch: service });
    const r = await cell.handler({ name: 'g1', state: 'on' }, ctx);
    expect(r).toEqual<WatchGroupResult>({ name: 'g1', enabled: true, requestedState: 'on' });
    expect(calls[0]?.patch.enabled).toBe(true);
  });

  it('resume → enabled=true, requestedState=resume', async () => {
    const { service } = fakeWatchForGroup();
    const cell = buildWatchGroupCell({ watch: service });
    const r = await cell.handler({ name: 'g1', state: 'resume' }, ctx);
    expect(r).toEqual<WatchGroupResult>({ name: 'g1', enabled: true, requestedState: 'resume' });
  });

  it('off → enabled=false, requestedState=off', async () => {
    const { service } = fakeWatchForGroup();
    const cell = buildWatchGroupCell({ watch: service });
    const r = await cell.handler({ name: 'g1', state: 'off' }, ctx);
    expect(r.enabled).toBe(false);
    expect(r.requestedState).toBe('off');
  });

  it('pause → enabled=false, requestedState=pause', async () => {
    const { service } = fakeWatchForGroup();
    const cell = buildWatchGroupCell({ watch: service });
    const r = await cell.handler({ name: 'g1', state: 'pause' }, ctx);
    expect(r.enabled).toBe(false);
    expect(r.requestedState).toBe('pause');
  });

  it('maps patchGroup throw → InstructionDispatchError(not-found)', async () => {
    const { service } = fakeWatchForGroup({
      patchReject: new Error('group does not exist'),
    });
    const cell = buildWatchGroupCell({ watch: service });
    await expect(
      cell.handler({ name: 'ghost', state: 'on' }, ctx),
    ).rejects.toMatchObject({ name: 'InstructionDispatchError', code: 'not-found' });
  });
});

describe('renderWatchGroup', () => {
  it('emits "watch group g1 resumed (on)" when enabled', () => {
    const out = renderWatchGroup({
      ok: true,
      data: { name: 'g1', enabled: true, requestedState: 'on' },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output.text).toBe('watch group g1 resumed (on)');
  });

  it('emits "watch group g1 paused (off)" when disabled', () => {
    const out = renderWatchGroup({
      ok: true,
      data: { name: 'g1', enabled: false, requestedState: 'off' },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.output.text).toBe('watch group g1 paused (off)');
  });

  it('passes through error envelope', () => {
    const out = renderWatchGroup({
      ok: false,
      error: { code: 'not-found', message: 'gone' },
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe('not-found');
  });
});
