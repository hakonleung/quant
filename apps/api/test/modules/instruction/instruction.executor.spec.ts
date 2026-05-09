import { instructionId, type InstructionResult } from '@quant/shared';
import { z } from 'zod';

import { FrozenClock } from '../../../src/common/clock.js';
import {
  InstructionAsyncBus,
  type InstructionAsyncJob,
} from '../../../src/modules/instruction/async/instruction-async.bus.js';
import { InstructionExecutor } from '../../../src/modules/instruction/instruction.executor.js';
import type { InstructionCtx } from '../../../src/modules/instruction/instruction.port.js';
import { InstructionRegistry } from '../../../src/modules/instruction/instruction.registry.js';
import type { InstructionSpec } from '../../../src/modules/instruction/instruction.types.js';

const ctx: InstructionCtx = { traceId: 't1', source: 'socket', userId: 'admin' };
// eslint-disable-next-line no-restricted-globals
const FROZEN_INSTANT = new Date('2026-05-09T00:00:00.000Z');

const focusSpec: InstructionSpec<{ code: string }> = {
  id: instructionId('focus'),
  summary: 'focus',
  summaryCn: '查询个股',
  group: 'market',
  argsSchema: z.object({ code: z.string().regex(/^\d{6}$/u) }).strict(),
  positional: ['code'],
};

const analyzeSpec: InstructionSpec<{ fresh: boolean }> = {
  id: instructionId('analyze'),
  summary: 'analyze',
  summaryCn: '账本分析',
  group: 'portfolio',
  argsSchema: z.object({ fresh: z.boolean().default(false) }).strict(),
  mode: 'async',
};

interface Harness {
  reg: InstructionRegistry;
  exe: InstructionExecutor;
  enqueued: InstructionAsyncJob[];
  enqueueShouldThrow: { value: boolean };
}

function build(): Harness {
  const reg = new InstructionRegistry();
  const enqueued: InstructionAsyncJob[] = [];
  const enqueueShouldThrow = { value: false };
  const asyncBus: Pick<InstructionAsyncBus, 'enqueue'> = {
    enqueue: (job) => {
      if (enqueueShouldThrow.value) return Promise.reject(new Error('queue down'));
      enqueued.push(job);
      return Promise.resolve();
    },
  };
  const clock = new FrozenClock(FROZEN_INSTANT);
  const exe = new InstructionExecutor(reg, asyncBus as unknown as InstructionAsyncBus, clock);
  return { reg, exe, enqueued, enqueueShouldThrow };
}

describe('InstructionExecutor.execute', () => {
  it('runs handler when args validate', async () => {
    const { reg, exe } = build();
    reg.register(focusSpec, {
      execute(args): Promise<InstructionResult> {
        return Promise.resolve({ ok: true, output: { text: `focus=${args.code}` } });
      },
    });
    const r = await exe.execute('focus', { code: '600519' }, ctx);
    expect(r).toEqual({ ok: true, output: { text: 'focus=600519' } });
  });
  it('returns not-found for unknown id', async () => {
    const { exe } = build();
    const r = await exe.execute('nope', {}, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not-found');
  });
  it('returns validation when args fail zod', async () => {
    const { reg, exe } = build();
    reg.register(focusSpec, {
      execute(): Promise<InstructionResult> {
        throw new Error('should not be called');
      },
    });
    const r = await exe.execute('focus', { code: 'abc' }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('validation');
  });
  it('wraps thrown handler error as code=handler', async () => {
    const { reg, exe } = build();
    reg.register(focusSpec, {
      execute(): Promise<InstructionResult> {
        throw new Error('boom');
      },
    });
    const r = await exe.execute('focus', { code: '600519' }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('handler');
      expect(r.error.message).toBe('boom');
    }
  });
});

describe('InstructionExecutor.executeLine', () => {
  it('parses positional and runs', async () => {
    const { reg, exe } = build();
    reg.register(focusSpec, {
      execute(args): Promise<InstructionResult> {
        return Promise.resolve({ ok: true, output: { text: args.code } });
      },
    });
    const r = await exe.executeLine('focus 600519', ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output.text).toBe('600519');
  });
  it('returns parse error on bad argv (unterminated quote)', async () => {
    const { reg, exe } = build();
    reg.register(focusSpec, {
      execute(): Promise<InstructionResult> {
        return Promise.resolve({ ok: true, output: { text: '' } });
      },
    });
    const r = await exe.executeLine('focus "abc', ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('parse');
  });
  it('returns parse=empty for blank', async () => {
    const { exe } = build();
    const r = await exe.executeLine('   ', ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('parse');
  });
});

describe('InstructionExecutor.dispatch (async mode)', () => {
  it('enqueues the job and returns started result', async () => {
    const { reg, exe, enqueued } = build();
    reg.register(analyzeSpec, {
      execute(): Promise<InstructionResult> {
        throw new Error('handler should not run synchronously');
      },
    });
    const dispatched = await exe.dispatch('analyze', { fresh: true }, ctx, {
      channel: 'feishu',
      target: 'oc_chat',
    });
    expect(dispatched.kind).toBe('async-queued');
    if (dispatched.kind === 'async-queued') {
      expect(dispatched.instructionId).toBe('analyze');
      expect(dispatched.result.ok).toBe(true);
      if (dispatched.result.ok) {
        expect(dispatched.result.output.text).toContain(`jobId=${dispatched.jobId}`);
      }
    }
    expect(enqueued).toHaveLength(1);
    const job = enqueued[0];
    expect(job).toBeDefined();
    if (job !== undefined) {
      expect(job.instructionId).toBe('analyze');
      expect(job.im?.channel).toBe('feishu');
      expect(job.im?.target).toBe('oc_chat');
    }
  });

  it('still surfaces zod failures synchronously without enqueueing', async () => {
    const { reg, exe, enqueued } = build();
    reg.register(analyzeSpec, {
      execute(): Promise<InstructionResult> {
        throw new Error('not reached');
      },
    });
    const dispatched = await exe.dispatch('analyze', { fresh: 'not-a-bool' }, ctx);
    expect(enqueued).toHaveLength(0);
    expect(dispatched.kind).toBe('sync');
    if (dispatched.kind === 'sync') {
      expect(dispatched.result.ok).toBe(false);
      if (!dispatched.result.ok) expect(dispatched.result.error.code).toBe('validation');
    }
  });

  it('returns sync errResult when enqueue itself throws', async () => {
    const { reg, exe, enqueueShouldThrow } = build();
    reg.register(analyzeSpec, {
      execute(): Promise<InstructionResult> {
        return Promise.resolve({ ok: true, output: { text: 'unused' } });
      },
    });
    enqueueShouldThrow.value = true;
    const dispatched = await exe.dispatch('analyze', {}, ctx);
    expect(dispatched.kind).toBe('sync');
    if (dispatched.kind === 'sync') {
      expect(dispatched.result.ok).toBe(false);
      if (!dispatched.result.ok) {
        expect(dispatched.result.error.code).toBe('handler');
        expect(dispatched.result.error.message).toContain('queue down');
      }
    }
  });
});
