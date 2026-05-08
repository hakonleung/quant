import { instructionId, type InstructionResult } from '@quant/shared';
import { z } from 'zod';

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

interface SendCall {
  readonly channel: string;
  readonly text: string;
}

function build(): {
  reg: InstructionRegistry;
  exe: InstructionExecutor;
  listener: InstructionImListener;
  sends: SendCall[];
} {
  const reg = new InstructionRegistry();
  const exe = new InstructionExecutor(reg);
  const sends: SendCall[] = [];
  const channels = {
    send(channel: string, req: { text: string }): Promise<{ accepted: string[] }> {
      sends.push({ channel, text: req.text });
      return Promise.resolve({ accepted: [channel] });
    },
  };
  reg.register(focusSpec, {
    execute(args): Promise<InstructionResult> {
      return Promise.resolve({ ok: true, output: { text: `focused ${args.code}` } });
    },
  });
  const auth: Pick<AuthService, 'resolveFromIm'> = {
    resolveFromIm: ({ openId }) =>
      Promise.resolve({
        id: `feishu:${openId}`,
        displayName: openId,
        source: 'im',
        imBootstrap: true,
      }),
  };
  const listener = new InstructionImListener(
    reg,
    exe,
    channels as unknown as ChannelService,
    auth as unknown as AuthService,
  );
  return { reg, exe, listener, sends };
}

// Frozen-time string keeps the test deterministic and avoids the
// no-restricted-globals('Date') rule.
const FAKE_RECEIVED_AT = '2024-01-02T03:04:05.000Z';

function inbound(text: string): InboundMessage {
  return {
    channel: 'slack',
    sender: 'slack:U1',
    text,
    target: 'C1',
    receivedAt: FAKE_RECEIVED_AT,
    raw: {},
  };
}

describe('InstructionImListener.onInbound', () => {
  it('replies with handler text on a known instruction', async () => {
    const { listener, sends } = build();
    await listener.onInbound(inbound('/focus 600519'));
    expect(sends).toHaveLength(1);
    expect(sends[0]?.channel).toBe('slack');
    expect(sends[0]?.text).toBe('focused 600519');
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
  });

  it('replies with validation error on bad args', async () => {
    const { listener, sends } = build();
    await listener.onInbound(inbound('/focus abc'));
    expect(sends).toHaveLength(1);
    expect(sends[0]?.text.startsWith('[validation]')).toBe(true);
  });
});
