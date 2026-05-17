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
import type { ChannelService } from '../../../src/modules/channel/channel.service.js';
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

interface ChannelSend {
  readonly channel: string;
  readonly text: string;
  readonly kind: string | undefined;
  readonly target: string | undefined;
  readonly meta: Readonly<Record<string, unknown>> | undefined;
}

function fakeJob(data: InstructionAsyncJob): Job<InstructionAsyncJob> {
  return { data } as unknown as Job<InstructionAsyncJob>;
}

function build(execute: () => Promise<InstructionResult>): {
  processor: InstructionAsyncProcessor;
  socketEmits: SocketEmit[];
  busEmits: BusEmit[];
  channelSends: ChannelSend[];
} {
  const socketEmits: SocketEmit[] = [];
  const busEmits: BusEmit[] = [];
  const channelSends: ChannelSend[] = [];
  const sockets: Pick<SocketBus, 'emitTo'> = {
    emitTo: <T extends SocketTopic>(
      userId: string,
      topic: T,
      payload: SocketTopicPayload<T>,
    ): void => {
      socketEmits.push({ userId, topic, payload });
    },
  };
  // Processor calls `executeHandler` (not `execute`) so it bypasses async
  // routing — without that, async-mode instructions would re-enqueue
  // themselves and the user would only ever see the "queued" ack.
  const executor: Pick<InstructionExecutor, 'executeHandler'> = {
    executeHandler: execute,
  };
  const bus: Pick<InstructionAsyncBus, 'emitStarted' | 'emitCompleted'> = {
    emitStarted: (p) => busEmits.push({ kind: 'started', payload: p }),
    emitCompleted: (p) => busEmits.push({ kind: 'completed', payload: p }),
  };
  const channels: Pick<ChannelService, 'send'> = {
    send: (channel, req) => {
      channelSends.push({
        channel,
        text: req.text,
        kind: req.kind,
        target: req.target,
        meta: req.meta,
      });
      return Promise.resolve({ accepted: [channel], activityIds: ['act'] });
    },
  };
  // eslint-disable-next-line no-restricted-globals -- test fixture; production injects Clock
  const t0 = new Date('2026-05-09T00:00:00.000Z');
  const clock = new FrozenClock(t0);
  const processor = new InstructionAsyncProcessor(
    executor as InstructionExecutor,
    bus as unknown as InstructionAsyncBus,
    sockets as unknown as SocketBus,
    channels as unknown as ChannelService,
    clock,
  );
  return { processor, socketEmits, busEmits, channelSends };
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

  it('pushes the completion card to IM when the job carries `im` hints', async () => {
    const { processor, channelSends } = build(() =>
      Promise.resolve({ ok: true, output: { text: 'analysis ready', meta: { foo: 'bar' } } }),
    );
    const imJob: InstructionAsyncJob = {
      ...job,
      im: { channel: 'feishu', target: 'chat_42' },
    };
    await processor.process(fakeJob(imJob));
    expect(channelSends).toHaveLength(1);
    const sent = channelSends[0];
    expect(sent?.channel).toBe('feishu');
    expect(sent?.target).toBe('chat_42');
    expect(sent?.text).toBe('analysis ready');
    expect(sent?.kind).toBe('instruction.async.completed');
    expect(sent?.meta?.['ok']).toBe(true);
    expect(sent?.meta?.['jobId']).toBe('job-1');
    expect(sent?.meta?.['foo']).toBe('bar');
  });

  it('does not send to IM when the job has no `im` hints (socket/http origin)', async () => {
    const { processor, channelSends } = build(() =>
      Promise.resolve({ ok: true, output: { text: 'done' } }),
    );
    await processor.process(fakeJob(job));
    expect(channelSends).toHaveLength(0);
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
