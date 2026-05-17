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

/**
 * Build a listener whose executor is wired to a fake InstructionCenter.
 * Mirrors how production resolves migrated instructions — `registry.get`
 * alone only sees the few legacy handlers, so the IM listener must route
 * through `executor.resolveEntry` (which checks the center first). A
 * regression here is what made center-owned commands silently no-op.
 */
function buildWithCenter(centerIds: readonly string[]): Harness & {
  centerCalls: { id: string; args: unknown }[];
} {
  const reg = new InstructionRegistry();
  const enqueued: InstructionAsyncJob[] = [];
  const asyncBus: Pick<InstructionAsyncBus, 'enqueue'> = {
    enqueue: (job) => {
      enqueued.push(job);
      return Promise.resolve();
    },
  };
  // eslint-disable-next-line no-restricted-globals -- test fixture
  const clock = new FrozenClock(new Date('2026-05-09T00:00:00.000Z'));
  const centerCalls: { id: string; args: unknown }[] = [];
  const center = {
    has: (id: string) => centerIds.includes(id),
    ids: () => centerIds,
    executeMigrated: (id: string, args: unknown) => {
      centerCalls.push({ id, args });
      return Promise.resolve({
        ok: true as const,
        output: { text: `center handled ${id} ${JSON.stringify(args)}` },
      });
    },
    peekImConfirmBypass: () => Promise.resolve(false),
    invokeRaw: () => Promise.resolve({}),
  };
  const exe = new InstructionExecutor(
    reg,
    asyncBus as unknown as InstructionAsyncBus,
    clock,
    center,
  );
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
  const auth: Pick<AuthService, 'resolveFromImChannel'> = {
    resolveFromImChannel: (channel, sender) =>
      Promise.resolve({
        id: sender,
        displayName: sender,
        source: 'im',
        imBootstrap: true,
      }),
  };
  const fullCfg: InstructionConfig = {
    imAllowlist: new Set<string>(),
    debugInstructionsEnabled: false,
  };
  const listener = new InstructionImListener(
    exe,
    channels as unknown as ChannelService,
    auth as unknown as AuthService,
    fullCfg,
  );
  return { reg, exe, listener, sends, enqueued, centerCalls };
}

describe('InstructionImListener.onInbound — InstructionCenter routing', () => {
  it('resolves a center-only command by id and forwards positional args', async () => {
    // `sector.show` is a real manifest entry with `positional: ['id']`.
    // Pre-fix, the IM listener used `registry.get('sector.show')` which
    // returned undefined → "unknown instruction" reply. Now it routes
    // through `executor.resolveEntry` which checks the center first.
    const { listener, sends, centerCalls } = buildWithCenter(['sector.show']);
    await listener.onInbound(inbound('/sector.show s1'));
    expect(sends).toHaveLength(1);
    expect(sends[0]?.meta).toEqual({ ok: true, instructionId: 'sector.show' });
    expect(centerCalls).toHaveLength(1);
    expect(centerCalls[0]?.id).toBe('sector.show');
    expect(centerCalls[0]?.args).toEqual(
      expect.objectContaining({ id: 's1' }),
    );
  });

  it('resolves a center command via its Chinese manifest alias', async () => {
    // `sector` declares `aliases: ['板块']` in the shared manifest. The
    // executor's knownIds() must include manifest aliases for center ids,
    // otherwise `板块` is just casual chat and gets dropped.
    const { listener, sends, centerCalls } = buildWithCenter(['sector']);
    await listener.onInbound(inbound('板块'));
    expect(sends).toHaveLength(1);
    expect(sends[0]?.meta).toEqual({ ok: true, instructionId: 'sector' });
    expect(centerCalls).toHaveLength(1);
    expect(centerCalls[0]?.id).toBe('sector');
  });
});

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
  it('enqueues but sends no started card, then bridges completion back to the IM thread', async () => {
    const { listener, sends, enqueued } = build();
    await listener.onInbound(inbound('/analyze'));
    expect(enqueued).toHaveLength(1);
    // No "queued" card is sent — async flow is silent until done.
    expect(sends).toHaveLength(0);

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

    expect(sends).toHaveLength(1);
    expect(sends[0]?.kind).toBe('instruction.async.completed');
    expect(sends[0]?.text).toBe('final analysis');
    expect(sends[0]?.meta?.['jobId']).toBe(job.jobId);
    expect(sends[0]?.meta?.['durationMs']).toBe(5000);
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

/**
 * Spec for the /agent fallback: bare messages from allowlisted senders
 * route to /agent (which then short-circuits with confirm-required when
 * not yet confirmed). Non-allowlisted senders stay silent regardless.
 */
const agentArgsSchema = z
  .object({
    q: z.string(),
    confirm: z.union([z.string(), z.boolean()]).optional(),
  })
  .strict();

const agentSpec: InstructionSpec<z.infer<typeof agentArgsSchema>> = {
  id: instructionId('agent'),
  summary: 'agent',
  summaryCn: 'agent',
  group: 'system',
  argsSchema: agentArgsSchema,
  positional: ['q'],
  imAliases: ['助手'],
  costsCredits: true,
};

function buildWithAgent(cfg?: Partial<InstructionConfig>): Harness {
  const h = build(cfg);
  h.reg.register(agentSpec, {
    execute: (args): Promise<InstructionResult> => {
      const isConfirmed =
        args.confirm === true || (typeof args.confirm === 'string' && args.confirm.length > 0);
      if (!isConfirmed) {
        return Promise.resolve({
          ok: false,
          error: {
            code: 'confirm-required',
            message: JSON.stringify({ q: args.q, kind: 'agent.paid' }),
          },
        });
      }
      return Promise.resolve({ ok: true, output: { text: '▶ /agent jobId=fake-job' } });
    },
  });
  return h;
}

describe('InstructionImListener.onInbound — /agent fallback', () => {
  it('routes bare allowlisted messages to /agent and returns the paid-confirm card', async () => {
    const allowlist = new Set<string>(['slack:U_GOOD']);
    const { listener, sends } = buildWithAgent({ imAllowlist: allowlist });
    await listener.onInbound(inbound('看看茅台估值', 'slack:U_GOOD'));
    expect(sends).toHaveLength(1);
    expect(sends[0]?.kind).toBe('agent.paid_confirm');
    expect(sends[0]?.meta?.['agentQ']).toBe('看看茅台估值');
    expect(sends[0]?.meta?.['code']).toBe('confirm-required');
  });

  it('keeps non-allowlisted casual chat silent even with /agent registered', async () => {
    const allowlist = new Set<string>(['slack:U_GOOD']);
    const { listener, sends } = buildWithAgent({ imAllowlist: allowlist });
    await listener.onInbound(inbound('hi everyone', 'slack:U_BAD'));
    expect(sends).toHaveLength(0);
  });

  it('with empty allowlist (open mode) still routes bare messages through', async () => {
    const { listener, sends } = buildWithAgent();
    await listener.onInbound(inbound('看看茅台'));
    expect(sends).toHaveLength(1);
    expect(sends[0]?.kind).toBe('agent.paid_confirm');
  });

  it('explicit /agent confirm=1 q=... runs through normally as instruction.reply', async () => {
    const { listener, sends } = buildWithAgent();
    await listener.onInbound(inbound('/agent confirm=1 q="hello"'));
    expect(sends).toHaveLength(1);
    expect(sends[0]?.kind).toBe('instruction.reply');
    expect(sends[0]?.text).toContain('▶ /agent jobId=fake-job');
  });

  it('does not fall back when /agent is not registered (legacy silent path)', async () => {
    const { listener, sends } = build();
    await listener.onInbound(inbound('看看茅台'));
    expect(sends).toHaveLength(0);
  });
});
