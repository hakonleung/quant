import { AgentHistoryStore } from '../../../src/modules/agent/agent-history.store.js';
import type { AuthService } from '../../../src/modules/auth/auth.service.js';

function fakeAuth(): AuthService {
  return {
    resolveFromImChannel: async () => ({
      id: 'admin',
      imBootstrap: false,
    }),
  } as unknown as AuthService;
}

describe('AgentHistoryStore', () => {
  it('append + recent return entries in oldest-first order', () => {
    const store = new AgentHistoryStore(fakeAuth());
    store.append('admin', 'feishu', { role: 'user', content: 'a', ts: '2026-05-09T00:00:00Z' });
    store.append('admin', 'feishu', { role: 'assistant', content: 'b', ts: '2026-05-09T00:00:01Z' });
    const recent = store.recent('admin', 'feishu');
    expect(recent.map((e) => e.content)).toEqual(['a', 'b']);
  });

  it('recent caps to the requested n', () => {
    const store = new AgentHistoryStore(fakeAuth());
    for (let i = 0; i < 12; i++) {
      store.append('admin', 'feishu', {
        role: 'user',
        content: `m${String(i)}`,
        ts: '2026-05-09T00:00:00Z',
      });
    }
    expect(store.recent('admin', 'feishu', 3).map((e) => e.content)).toEqual([
      'm9',
      'm10',
      'm11',
    ]);
  });

  it('isolates per (userId, channel) — slots do not bleed', () => {
    const store = new AgentHistoryStore(fakeAuth());
    store.append('a', 'feishu', { role: 'user', content: 'A', ts: '1' });
    store.append('b', 'feishu', { role: 'user', content: 'B', ts: '1' });
    store.append('a', 'slack', { role: 'user', content: 'A2', ts: '1' });
    expect(store.recent('a', 'feishu').map((e) => e.content)).toEqual(['A']);
    expect(store.recent('b', 'feishu').map((e) => e.content)).toEqual(['B']);
    expect(store.recent('a', 'slack').map((e) => e.content)).toEqual(['A2']);
    expect(store.size()).toBe(3);
  });

  it('caps per-slot entries (drops oldest beyond MAX_ENTRIES_PER_KEY=32)', () => {
    const store = new AgentHistoryStore(fakeAuth());
    for (let i = 0; i < 40; i++) {
      store.append('admin', 'feishu', {
        role: 'user',
        content: `m${String(i)}`,
        ts: '1',
      });
    }
    const entries = store.recent('admin', 'feishu', 100);
    expect(entries.length).toBe(32);
    expect(entries[0]?.content).toBe('m8');
    expect(entries[entries.length - 1]?.content).toBe('m39');
  });

  it('clear drops a slot', () => {
    const store = new AgentHistoryStore(fakeAuth());
    store.append('admin', 'feishu', { role: 'user', content: 'x', ts: '1' });
    store.clear('admin', 'feishu');
    expect(store.recent('admin', 'feishu')).toEqual([]);
    expect(store.size()).toBe(0);
  });

  it('onInbound uses AuthService to resolve userId before storing', async () => {
    const store = new AgentHistoryStore(fakeAuth());
    await store.onInbound({
      channel: 'feishu',
      sender: 'feishu:ou_xyz',
      text: 'hi',
      receivedAt: '2026-05-09T00:00:00Z',
      raw: {},
    });
    expect(store.recent('admin', 'feishu').map((e) => e.content)).toEqual(['hi']);
  });

  it('onInbound silently ignores AuthService failures (history is non-critical)', async () => {
    const failing = {
      resolveFromImChannel: async () => {
        throw new Error('auth offline');
      },
    } as unknown as AuthService;
    const store = new AgentHistoryStore(failing);
    await store.onInbound({
      channel: 'feishu',
      sender: 'feishu:ou_xyz',
      text: 'hi',
      receivedAt: '2026-05-09T00:00:00Z',
      raw: {},
    });
    expect(store.size()).toBe(0);
  });
});
