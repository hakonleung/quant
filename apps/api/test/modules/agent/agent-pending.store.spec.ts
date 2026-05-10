import type { ChatMessage, ChatToolCall } from '@quant/shared';

import {
  AgentPendingStore,
  type AgentPendingSnapshot,
} from '../../../src/modules/agent/agent-pending.store.js';

function snap(overrides: Partial<AgentPendingSnapshot> = {}): AgentPendingSnapshot {
  const messages: ChatMessage[] = [{ role: 'user', content: 'hi' }];
  const toolCalls: ChatToolCall[] = [{ id: 'tc-1', toolId: 'focus', args: { code: '600519' } }];
  return {
    userId: 'admin',
    traceId: 't-1',
    jobId: 'job-1',
    delivery: { kind: 'socket', userId: 'admin' },
    messages,
    toolCalls,
    usageAcc: { input: 0, output: 0, total: 0 },
    toolCallCount: 0,
    maxToolCalls: 5,
    resumeStep: 0,
    ...overrides,
  };
}

describe('AgentPendingStore', () => {
  it('put returns a non-empty correlationId and take lifts the snapshot once', () => {
    const store = new AgentPendingStore();
    const id = store.put(snap());
    expect(id.length).toBeGreaterThan(0);
    expect(store.size()).toBe(1);
    const lifted = store.take(id);
    expect(lifted?.userId).toBe('admin');
    expect(store.size()).toBe(0);
    // Second take returns null — consumed.
    expect(store.take(id)).toBeNull();
    store.shutdown();
  });

  it('take returns null after the TTL expires', () => {
    const store = new AgentPendingStore();
    const id = store.put(snap(), 1); // TTL = 1ms
    // Wait deterministically past TTL via a microtask + setTimeout.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(store.take(id)).toBeNull();
        store.shutdown();
        resolve();
      }, 5);
    });
  });

  it('drop removes the snapshot without surfacing it', () => {
    const store = new AgentPendingStore();
    const id = store.put(snap());
    store.drop(id);
    expect(store.take(id)).toBeNull();
    store.shutdown();
  });

  it('correlationId is unguessable (random uuid)', () => {
    const store = new AgentPendingStore();
    const a = store.put(snap());
    const b = store.put(snap());
    expect(a).not.toBe(b);
    expect(a.length).toBe(b.length);
    store.shutdown();
  });
});
