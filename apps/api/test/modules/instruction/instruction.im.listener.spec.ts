import {
  instructionId,
  type InstructionAsyncCompletedPayload,
  type InstructionResult,
} from '@quant/shared';
import { z } from 'zod';

import { FrozenClock } from '../../../src/common/clock.js';
import {
  InstructionAsyncBus,
  type InstructionAsyncJob,
} from '../../../src/modules/instruction/async/instruction-async.bus.js';
import { type InstructionConfig } from '../../../src/modules/instruction/instruction.config.js';
import { InstructionExecutor } from '../../../src/modules/instruction/instruction.executor.js';
import { InstructionImListener } from '../../../src/modules/instruction/instruction.im.listener.js';
import { InstructionRegistry } from '../../../src/modules/instruction/instruction.registry.js';
import type { InstructionSpec } from '../../../src/modules/instruction/instruction.types.js';
import type { ChannelService } from '../../../src/modules/channel/channel.service.js';
import type { InboundMessage } from '../../../src/modules/channel/ports/channel-adapter.port.js';
import type { AuthService } from '../../../src/modules/auth/auth.service.js';

const focusSpec: InstructionSpec<{ code: string }> = {
  id: instructionId('focus'),
  summary: 'focus',
  argsSchema: z.object({ code: z.string().regex(/^\d{6}$/u) }).strict(),
  positional: ['code'],
};

const analyzeSpec: InstructionSpec<{ fresh: boolean }> = {
  id: instructionId('analyze'),
  summary: 'analyze',
  argsSchema: z.object({ fresh: z.boolean().default(false) }).strict(),
  mode: 'async',
};

interface SendCall {
  readonly channel: string;
  readonly text: string;
  readonly kind: string | undefined;
  readonly meta: Readonly<Record<string, unknown>> | undefined;
  readonly target: string | undefined;
}

interface Harness {
  reg: InstructionRegistry;
  exe: InstructionExecutor;
  listener: InstructionImListener;
  sends: SendCall[];
  enqueued: InstructionAsyncJob[];
}

function build(cfg?: Partial<InstructionConfig>): Harness {
  const reg = new InstructionRegistry();
  const enqueued: InstructionAsyncJob[] = [];
  const asyncBus: Pick<InstructionAsyncBus, 'enqueue'> = {
    enqueue: (job) => {
      enqueued.push(job);
      return Promise.resolve();
    },
  };
  // eslint-disable-next-line no-restricted-globals -- test fixture; production injects Clock
  const clock = new FrozenClock(new Date('2026-05-09T00:00:00.000Z'));
  const exe = new InstructionExecutor(reg, asyncBus as unknown as InstructionAsyncBus, clock);
  const sends: SendCall[] = [];
  const channels: Pick<ChannelService, 'send'> = {
    send: (channel, req) => {
      sends.push({
        channel,
        text: req.text,
        kind: req.kind,
        meta: req.meta,
        target: req.target,
      });
      return Promise.resolve({ accepted: [channel], activityIds: ['act'] });
    },
  };
  reg.register(focusSpec, {
    execute(args): Promise<InstructionResult> {
      return Promise.resolve({ ok: true, output: { text: `focused ${args.code}` } });
    },
  });
  reg.register(analyzeSpec, {
    execute(): Promise<InstructionResult> {
      return Promise.resolve({ ok: true, output: { text: 'analysis done' } });
    },
  });
  const auth: Pick<AuthService, 'resolveFromImChannel'> = {
    resolveFromImChannel: (channel, sender) => {
      const prefix = `${channel}:`;
      const externalId = sender.startsWith(prefix) ? sender.slice(prefix.length) : sender;
      const id = channel === 'feishu' ? `feishu:${externalId}` : sender;
      return Promise.resolve({
        id,
        displayName: externalId,
        source: 'im',
        imBootstrap: true,
      });
    },
  };
  const fullCfg: InstructionConfig = {
    imAllowlist: cfg?.imAllowlist ?? new Set<string>(),
    debugInstructionsEnabled: cfg?.debugInstructionsEnabled ?? false,
  };
  const listener = new InstructionImListener(
    reg,
    exe,
    channels as unknown as ChannelService,
    auth as unknown as AuthService,
    fullCfg,
  );
  return { reg, exe, listener, sends, enqueued };
}

const FAKE_RECEIVED_AT = '2024-01-02T03:04:05.000Z';

function inbound(text: string, sender = 'slack:U1', target = 'C1'): InboundMessage {
  return {
    channel: 'slack',
    sender,
    text,
    target,
    receivedAt: FAKE_RECEIVED_AT,
    raw: {},
  };
}

describe('InstructionImListener.onInbound — sync path', () => {
  it('replies with handler text on a known instruction', async () => {
    const { listener, sends } = build();
    await listener.onInbound(inbound('/focus 600519'));
    expect(sends).toHaveLength(1);
    expect(sends[0]?.channel).toBe('slack');
    expect(sends[0]?.text).toBe('focused 600519');
    expect(sends[0]?.kind).toBe('instruction.reply');
    expect(sends[0]?.meta).toEqual({ ok: true, instructionId: 'focus' });
  });

  it('silently ignores casual chat (no slash prefix)', async () => {
    const { listener, sends } = build();
    await listener.onInbound(inbound('hello team'));
    expect(sends).toHaveLength(0);
  });

  it('replies with parse error on unknown instruction', async () => {
    const { listener, sends } = build();
    await listener.onInbound(inbound('/unknown'));
    expect(sends).toHaveLength(1);
    expect(sends[0]?.text.startsWith('[parse]')).toBe(true);
    expect(sends[0]?.meta).toEqual({ ok: false, instructionId: null, code: 'parse' });
  });

  it('replies with validation error on bad args', async () => {
    const { listener, sends } = build();
    await listener.onInbound(inbound('/focus abc'));
    expect(sends).toHaveLength(1);
    expect(sends[0]?.text.startsWith('[validation]')).toBe(true);
    expect(sends[0]?.meta).toEqual({
      ok: false,
      instructionId: 'focus',
      code: 'validation',
    });
  });
});

describe('InstructionImListener.onInbound — ACL', () => {
  it('forbids senders outside the allowlist', async () => {
    const allowlist = new Set<string>(['slack:U_GOOD']);
    const { listener, sends } = build({ imAllowlist: allowlist });
    await listener.onInbound(inbound('/focus 600519', 'slack:U_BAD'));
    expect(sends).toHaveLength(1);
    expect(sends[0]?.text.startsWith('[forbidden]')).toBe(true);
    expect(sends[0]?.meta?.['code']).toBe('forbidden');
  });

  it('still ignores casual chat from non-allowlisted senders', async () => {
    const allowlist = new Set<string>(['slack:U_GOOD']);
    const { listener, sends } = build({ imAllowlist: allowlist });
    await listener.onInbound(inbound('hi everyone', 'slack:U_BAD'));
    expect(sends).toHaveLength(0);
  });

  it('lets allowlisted senders through', async () => {
    const allowlist = new Set<string>(['slack:U_GOOD']);
    const { listener, sends } = build({ imAllowlist: allowlist });
    await listener.onInbound(inbound('/focus 600519', 'slack:U_GOOD'));
    expect(sends).toHaveLength(1);
    expect(sends[0]?.text).toBe('focused 600519');
  });
});

describe('InstructionImListener.onInbound — async path', () => {
  it('posts a started reply and bridges completion back to the IM thread', async () => {
    const { listener, sends, enqueued } = build();
    await listener.onInbound(inbound('/analyze'));
    expect(enqueued).toHaveLength(1);
    expect(sends).toHaveLength(1);
    expect(sends[0]?.kind).toBe('instruction.async.started');

    const job = enqueued[0];
    expect(job).toBeDefined();
    if (job === undefined) return;
    const completion: InstructionAsyncCompletedPayload = {
      jobId: job.jobId,
      instructionId: 'analyze',
      userId: job.ctx.userId,
      result: { ok: true, output: { text: 'final analysis' } },
      finishedAt: '2026-05-09T00:00:05.000Z',
      durationMs: 5000,
    };
    await listener.onAsyncCompleted(completion);

    expect(sends).toHaveLength(2);
    expect(sends[1]?.kind).toBe('instruction.async.completed');
    expect(sends[1]?.text).toBe('final analysis');
    expect(sends[1]?.meta?.['jobId']).toBe(job.jobId);
    expect(sends[1]?.meta?.['durationMs']).toBe(5000);
  });

  it('ignores completion events for jobs that did not originate from IM', async () => {
    const { listener, sends } = build();
    await listener.onAsyncCompleted({
      jobId: 'orphan',
      instructionId: 'analyze',
      userId: 'admin',
      result: { ok: true, output: { text: 'noop' } },
      finishedAt: '2026-05-09T00:00:00.000Z',
      durationMs: 0,
    });
    expect(sends).toHaveLength(0);
  });
});
