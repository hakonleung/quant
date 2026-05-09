import { instructionId } from '@quant/shared';

import {
  AgentHistoryStore,
} from '../../../src/modules/agent/agent-history.store.js';
import { AgentInstructionHandler } from '../../../src/modules/agent/instructions/agent.handler.js';
import type { AgentService } from '../../../src/modules/agent/agent.service.js';
import { InstructionRegistry } from '../../../src/modules/instruction/instruction.registry.js';
import type { InstructionCtx } from '../../../src/modules/instruction/instruction.port.js';
import type { AuthService } from '../../../src/modules/auth/auth.service.js';

const sockCtx: InstructionCtx = { traceId: 't1', source: 'socket', userId: 'admin' };

function fakeAgent(): { svc: AgentService; calls: unknown[] } {
  const calls: unknown[] = [];
  const svc = {
    resolveMaxToolCalls: () => 5,
    runFresh: async (opts: unknown): Promise<void> => {
      calls.push(opts);
    },
  } as unknown as AgentService;
  return { svc, calls };
}

function fakeAuth(): AuthService {
  return {
    resolveFromImChannel: async () => ({ id: 'admin', imBootstrap: false }),
  } as unknown as AuthService;
}

describe('AgentInstructionHandler', () => {
  it('returns confirm-required when confirm flag is missing', async () => {
    const { svc } = fakeAgent();
    const h = new AgentInstructionHandler(new InstructionRegistry(), svc, new AgentHistoryStore(fakeAuth()));
    const r = await h.execute({ q: 'hello' }, sockCtx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('confirm-required');
      const payload = JSON.parse(r.error.message) as { q: string; kind: string };
      expect(payload.q).toBe('hello');
      expect(payload.kind).toBe('agent.paid');
    }
  });

  it('with confirm=true kicks off the loop and returns "▶ /agent jobId=…"', async () => {
    const { svc, calls } = fakeAgent();
    const h = new AgentInstructionHandler(new InstructionRegistry(), svc, new AgentHistoryStore(fakeAuth()));
    const r = await h.execute({ q: 'fundamentals', confirm: true }, sockCtx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.text).toMatch(/\/agent 启动 jobId=[0-9a-f-]+/);
    }
    // Wait for the detached `runFresh` invocation.
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls.length).toBe(1);
    const opts = calls[0] as { q: string; maxToolCalls: number; delivery: { kind: string } };
    expect(opts.q).toBe('fundamentals');
    expect(opts.maxToolCalls).toBe(5);
    expect(opts.delivery.kind).toBe('socket');
  });

  it('rejects when source is unsupported (no delivery target)', async () => {
    const { svc } = fakeAgent();
    const h = new AgentInstructionHandler(new InstructionRegistry(), svc, new AgentHistoryStore(fakeAuth()));
    const ctx: InstructionCtx = {
      traceId: 't1',
      source: 'im',
      userId: 'admin',
      // no channelId / target — invalid IM context
    };
    const r = await h.execute({ q: 'x', confirm: true }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
  });

  it('threads explicit context through to the loop', async () => {
    const { svc, calls } = fakeAgent();
    const h = new AgentInstructionHandler(new InstructionRegistry(), svc, new AgentHistoryStore(fakeAuth()));
    await h.execute(
      {
        q: 'follow-up',
        confirm: true,
        context: [{ role: 'user', content: 'previous', ts: '2026-05-09T00:00:00.000Z' }],
      },
      sockCtx,
    );
    await new Promise((resolve) => setImmediate(resolve));
    const opts = calls[0] as { history: { role: string; content: string }[] };
    expect(opts.history).toEqual([{ role: 'user', content: 'previous' }]);
  });

  it('declares costsCredits=true and id="agent"', () => {
    const { svc } = fakeAgent();
    const h = new AgentInstructionHandler(new InstructionRegistry(), svc, new AgentHistoryStore(fakeAuth()));
    expect(h.spec.id).toBe(instructionId('agent'));
    expect(h.spec.costsCredits).toBe(true);
    expect(h.spec.imAliases).toContain('助手');
  });
});
