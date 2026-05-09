import {
  type InstructionAsyncCompletedPayload,
  type InstructionAsyncStartedPayload,
  type InstructionResult,
  type SocketTopic,
  type SocketTopicPayload,
} from '@quant/shared';
import type { Job } from 'bullmq';

import { FrozenClock } from '../../../src/common/clock.js';
import {
  InstructionAsyncBus,
  type InstructionAsyncJob,
} from '../../../src/modules/instruction/async/instruction-async.bus.js';
import { InstructionAsyncProcessor } from '../../../src/modules/instruction/async/instruction-async.processor.js';
import { InstructionExecutor } from '../../../src/modules/instruction/instruction.executor.js';
import type { SocketBus } from '../../../src/modules/socket/socket-bus.service.js';

interface SocketEmit {
  readonly topic: SocketTopic;
  readonly userId: string;
  readonly payload: unknown;
}

interface BusEmit {
  readonly kind: 'started' | 'completed';
  readonly payload: unknown;
}

function fakeJob(data: InstructionAsyncJob): Job<InstructionAsyncJob> {
  return { data } as unknown as Job<InstructionAsyncJob>;
}

function build(execute: () => Promise<InstructionResult>): {
  processor: InstructionAsyncProcessor;
  socketEmits: SocketEmit[];
  busEmits: BusEmit[];
} {
  const socketEmits: SocketEmit[] = [];
  const busEmits: BusEmit[] = [];
  const sockets: Pick<SocketBus, 'emitTo'> = {
    emitTo: <T extends SocketTopic>(
      userId: string,
      topic: T,
      payload: SocketTopicPayload<T>,
    ): void => {
      socketEmits.push({ userId, topic, payload });
    },
  };
  const executor: Pick<InstructionExecutor, 'execute'> = {
    execute,
  };
  const bus: Pick<InstructionAsyncBus, 'emitStarted' | 'emitCompleted'> = {
    emitStarted: (p) => busEmits.push({ kind: 'started', payload: p }),
    emitCompleted: (p) => busEmits.push({ kind: 'completed', payload: p }),
  };
  // eslint-disable-next-line no-restricted-globals -- test fixture; production injects Clock
  const t0 = new Date('2026-05-09T00:00:00.000Z');
  const clock = new FrozenClock(t0);
  const processor = new InstructionAsyncProcessor(
    executor as InstructionExecutor,
    bus as unknown as InstructionAsyncBus,
    sockets as unknown as SocketBus,
    clock,
  );
  return { processor, socketEmits, busEmits };
}

const job: InstructionAsyncJob = {
  jobId: 'job-1',
  instructionId: 'analyze',
  rawArgs: { fresh: '1' },
  ctx: { traceId: 't1', source: 'im', userId: 'feishu:ou_a' },
  enqueuedAt: '2026-05-09T00:00:00.000Z',
};

describe('InstructionAsyncProcessor.process', () => {
  it('emits started + completed (ok) when handler resolves', async () => {
    const { processor, socketEmits, busEmits } = build(() =>
      Promise.resolve({ ok: true, output: { text: 'done' } }),
    );
    const out = await processor.process(fakeJob(job));
    expect(out).toEqual({ ok: true });
    expect(socketEmits.map((e) => e.topic)).toEqual([
      'instruction.async.started',
      'instruction.async.completed',
    ]);
    expect(busEmits.map((e) => e.kind)).toEqual(['started', 'completed']);
    const started = busEmits[0]?.payload as InstructionAsyncStartedPayload;
    expect(started.jobId).toBe('job-1');
    expect(started.instructionId).toBe('analyze');
    expect(started.userId).toBe('feishu:ou_a');
    const completed = busEmits[1]?.payload as InstructionAsyncCompletedPayload;
    expect(completed.result.ok).toBe(true);
    expect(completed.durationMs).toBe(0);
  });

  it('still emits completed (err) when handler returns errResult', async () => {
    const { processor, busEmits } = build(() =>
      Promise.resolve({ ok: false, error: { code: 'handler', message: 'nope' } }),
    );
    const out = await processor.process(fakeJob(job));
    expect(out).toEqual({ ok: false });
    const completed = busEmits[1]?.payload as InstructionAsyncCompletedPayload;
    expect(completed.result.ok).toBe(false);
    if (!completed.result.ok) expect(completed.result.error.code).toBe('handler');
  });

  it('wraps an executor crash as completed (handler error)', async () => {
    const { processor, busEmits } = build(() => {
      throw new Error('exec crash');
    });
    const out = await processor.process(fakeJob(job));
    expect(out).toEqual({ ok: false });
    const completed = busEmits[1]?.payload as InstructionAsyncCompletedPayload;
    expect(completed.result.ok).toBe(false);
    if (!completed.result.ok) {
      expect(completed.result.error.code).toBe('handler');
      expect(completed.result.error.message).toContain('exec crash');
    }
  });
});
