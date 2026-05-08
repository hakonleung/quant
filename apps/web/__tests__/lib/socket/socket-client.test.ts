/**
 * Ref-counted topic subscription smoke tests.
 *
 * The singleton multiplexes every component watching the same socket
 * topic onto a single over-the-wire `subscribe`/`unsubscribe` pair.
 * These cases exercise the count transitions (0→1, 1→2, 2→1, 1→0) and
 * the reconnect rebind path so a regression that re-introduces the
 * per-subscriber emit storm fails loudly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _getTopicRefCount,
  _resetSocket,
  subscribeTopic,
} from '../../../lib/socket/socket-client.js';

interface FakeSocket {
  connected: boolean;
  readonly emit: ReturnType<typeof vi.fn>;
  readonly on: ReturnType<typeof vi.fn>;
  readonly off: ReturnType<typeof vi.fn>;
  readonly disconnect: ReturnType<typeof vi.fn>;
  /** Listeners registered via .on(), keyed by event name. */
  readonly listeners: Map<string, Set<(arg: unknown) => void>>;
}

function makeFakeSocket(connected = true): FakeSocket {
  const listeners = new Map<string, Set<(arg: unknown) => void>>();
  const on = vi.fn((event: string, handler: (arg: unknown) => void) => {
    const set = listeners.get(event) ?? new Set<(arg: unknown) => void>();
    set.add(handler);
    listeners.set(event, set);
  });
  const off = vi.fn((event: string, handler: (arg: unknown) => void) => {
    listeners.get(event)?.delete(handler);
  });
  return {
    connected,
    emit: vi.fn(),
    on,
    off,
    disconnect: vi.fn(),
    listeners,
  };
}

let fake: FakeSocket;

vi.mock('socket.io-client', () => ({
  io: () => fake,
}));

beforeEach(() => {
  fake = makeFakeSocket(true);
  _resetSocket();
});

afterEach(() => {
  _resetSocket();
});

describe('subscribeTopic ref counting', () => {
  it('first subscriber emits subscribe over the wire', () => {
    subscribeTopic('queue.snapshot', () => undefined);
    expect(fake.emit).toHaveBeenCalledWith('subscribe', { topics: ['queue.snapshot'] });
    expect(_getTopicRefCount('queue.snapshot')).toBe(1);
  });

  it('second subscriber piggy-backs without a fresh subscribe', () => {
    subscribeTopic('queue.snapshot', () => undefined);
    fake.emit.mockClear();
    subscribeTopic('queue.snapshot', () => undefined);
    expect(fake.emit).not.toHaveBeenCalled();
    expect(_getTopicRefCount('queue.snapshot')).toBe(2);
  });

  it('non-final unsubscribe keeps the wire subscription open', () => {
    const off1 = subscribeTopic('queue.snapshot', () => undefined);
    subscribeTopic('queue.snapshot', () => undefined);
    fake.emit.mockClear();
    off1();
    expect(fake.emit).not.toHaveBeenCalled();
    expect(_getTopicRefCount('queue.snapshot')).toBe(1);
  });

  it('final unsubscribe drops the wire subscription', () => {
    const off = subscribeTopic('queue.snapshot', () => undefined);
    fake.emit.mockClear();
    off();
    expect(fake.emit).toHaveBeenCalledWith('unsubscribe', { topics: ['queue.snapshot'] });
    expect(_getTopicRefCount('queue.snapshot')).toBe(0);
  });

  it('does not emit unsubscribe when the socket is offline', () => {
    fake.connected = false;
    const off = subscribeTopic('queue.snapshot', () => undefined);
    fake.emit.mockClear();
    off();
    expect(fake.emit).not.toHaveBeenCalled();
  });

  it('queues subscribe via the connect handler when offline', () => {
    fake.connected = false;
    subscribeTopic('queue.snapshot', () => undefined);
    expect(fake.emit).not.toHaveBeenCalled();
    // Simulate the socket coming up.
    const onConnect = [...(fake.listeners.get('connect') ?? [])][0];
    expect(onConnect).toBeDefined();
    onConnect?.(undefined);
    expect(fake.emit).toHaveBeenCalledWith('subscribe', { topics: ['queue.snapshot'] });
  });
});

describe('subscribeTopic dispatch', () => {
  it('routes envelope payloads to the matching topic handler', () => {
    const handler = vi.fn();
    subscribeTopic('queue.snapshot', handler);
    const dispatch = [...(fake.listeners.get('event') ?? [])][0];
    dispatch?.({
      topic: 'queue.snapshot',
      ts: '2026-05-08T00:00:00.000Z',
      payload: { hi: 'mom' },
    });
    expect(handler).toHaveBeenCalledWith({ hi: 'mom' });
  });

  it('drops envelopes addressed to a different topic', () => {
    const handler = vi.fn();
    subscribeTopic('queue.snapshot', handler);
    const dispatch = [...(fake.listeners.get('event') ?? [])][0];
    dispatch?.({
      topic: 'watch.snapshot',
      ts: '2026-05-08T00:00:00.000Z',
      payload: [],
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('drops malformed envelopes silently', () => {
    const handler = vi.fn();
    subscribeTopic('queue.snapshot', handler);
    const dispatch = [...(fake.listeners.get('event') ?? [])][0];
    dispatch?.({ not: 'an envelope' });
    expect(handler).not.toHaveBeenCalled();
  });
});
