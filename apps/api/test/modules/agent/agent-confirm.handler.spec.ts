import { instructionId } from '@quant/shared';

import { AgentPendingStore } from '../../../src/modules/agent/agent-pending.store.js';
import { AgentConfirmInstructionHandler } from '../../../src/modules/agent/instructions/agent-confirm.handler.js';
import type { AgentService } from '../../../src/modules/agent/agent.service.js';
import { InstructionRegistry } from '../../../src/modules/instruction/instruction.registry.js';
import type { InstructionCtx } from '../../../src/modules/instruction/instruction.port.js';

const ctx: InstructionCtx = { traceId: 't1', source: 'socket', userId: 'admin' };

function fakeAgent(): { svc: AgentService; resumeCalls: { approve: boolean }[] } {
  const resumeCalls: { approve: boolean }[] = [];
  const svc = {
    resume: async (_snapshot: unknown, approve: boolean): Promise<void> => {
      resumeCalls.push({ approve });
    },
  } as unknown as AgentService;
  return { svc, resumeCalls };
}

function makePending(userId: string): { store: AgentPendingStore; correlationId: string } {
  const store = new AgentPendingStore();
  const correlationId = store.put({
    userId,
    traceId: 't',
    jobId: 'j',
    delivery: { kind: 'socket', userId },
    messages: [],
    toolCalls: [],
    usageAcc: { input: 0, output: 0, total: 0 },
    toolCallCount: 0,
    maxToolCalls: 5,
    resumeStep: 0,
  });
  return { store, correlationId };
}

describe('AgentConfirmInstructionHandler', () => {
  it('returns not-found when correlationId is unknown', async () => {
    const { svc } = fakeAgent();
    const store = new AgentPendingStore();
    const h = new AgentConfirmInstructionHandler(new InstructionRegistry(), svc, store);
    const r = await h.execute({ correlationId: 'never', approve: true }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('not-found');
    store.shutdown();
  });

  it('approve=true lifts snapshot + calls resume(approve=true)', async () => {
    const { svc, resumeCalls } = fakeAgent();
    const { store, correlationId } = makePending('admin');
    const h = new AgentConfirmInstructionHandler(new InstructionRegistry(), svc, store);
    const r = await h.execute({ correlationId, approve: true }, ctx);
    expect(r.ok).toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(resumeCalls).toEqual([{ approve: true }]);
    // Snapshot consumed.
    expect(store.size()).toBe(0);
    store.shutdown();
  });

  it('approve=false still lifts the snapshot and resumes with cancel', async () => {
    const { svc, resumeCalls } = fakeAgent();
    const { store, correlationId } = makePending('admin');
    const h = new AgentConfirmInstructionHandler(new InstructionRegistry(), svc, store);
    await h.execute({ correlationId, approve: false }, ctx);
    await new Promise((resolve) => setImmediate(resolve));
    expect(resumeCalls).toEqual([{ approve: false }]);
    store.shutdown();
  });

  it('rejects cross-user resume attempts', async () => {
    const { svc } = fakeAgent();
    const { store, correlationId } = makePending('alice');
    const h = new AgentConfirmInstructionHandler(new InstructionRegistry(), svc, store);
    const r = await h.execute({ correlationId, approve: true }, {
      ...ctx,
      userId: 'mallory',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('forbidden');
    store.shutdown();
  });

  it('declares id="agent.confirm"', () => {
    const { svc } = fakeAgent();
    const store = new AgentPendingStore();
    const h = new AgentConfirmInstructionHandler(new InstructionRegistry(), svc, store);
    expect(h.spec.id).toBe(instructionId('agent.confirm'));
    store.shutdown();
  });
});
