/**
 * Browser-side singleton for the realtime Socket.IO connection
 * (`docs/modules/12-socket.md`).
 *
 * The web app talks to the NestJS gateway directly here — same-host
 * different-port CORS lets us skip the Next BFF for the socket alone
 * (the rest of the BFF anti-corruption layer remains for HTTP). The
 * default URL is `http://<current-hostname>:3001`, which works whether
 * the user opened the app via `localhost` or `127.0.0.1`. Override
 * with `NEXT_PUBLIC_QUANT_SOCKET_URL` for non-loopback deploys.
 *
 * Topic subscriptions are **ref-counted**: N components watching the
 * same topic produce exactly one `subscribe` (and one `unsubscribe`)
 * over the wire. Each call to {@link subscribeTopic} returns an
 * unsubscribe function; the singleton keeps the count and only emits
 * to the gateway on 0 ↔ 1 transitions. This both halves chat with the
 * server when feat panes mount in parallel and prevents stale dupe
 * subscriptions from fast remount/unmount cycles.
 */

'use client';

import { SocketEnvelopeSchema, type SocketTopic } from '@quant/shared';
import { io, type Socket } from 'socket.io-client';

let socketSingleton: Socket | null = null;

function resolveUrl(): string {
  const env = process.env['NEXT_PUBLIC_QUANT_SOCKET_URL'];
  if (typeof env === 'string' && env.length > 0) return env;
  if (typeof window === 'undefined') return 'http://127.0.0.1:3001';
  const port = process.env['NEXT_PUBLIC_QUANT_API_PORT'] ?? '3001';
  return `${window.location.protocol}//${window.location.hostname}:${port}`;
}

export function getSocket(): Socket {
  if (socketSingleton !== null) return socketSingleton;
  socketSingleton = io(resolveUrl(), {
    withCredentials: true,
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 10_000,
  });
  return socketSingleton;
}

/** Force a reconnect — useful for tests; not exposed in production UI. */
export function _resetSocket(): void {
  if (socketSingleton !== null) {
    socketSingleton.disconnect();
    socketSingleton = null;
  }
  refCounts.clear();
  reconnectHandlers.clear();
  topicHandlers.clear();
  globalListenerInstalled = false;
}

// ─── topic ref-count ─────────────────────────────────────────────────

type TopicHandler = (payload: unknown) => void;

// Internal maps key on plain `string` so the dispatcher can look up
// the topic from a parsed envelope (whose `topic` is a `z.string()`,
// not the narrower union). Public API still constrains the topic
// argument to `SocketTopic`.
const refCounts = new Map<string, number>();
const reconnectHandlers = new Map<string, () => void>();
const topicHandlers = new Map<string, Set<TopicHandler>>();
let globalListenerInstalled = false;

function installGlobalListener(socket: Socket): void {
  if (globalListenerInstalled) return;
  globalListenerInstalled = true;
  socket.on('event', (raw: unknown): void => {
    const env = SocketEnvelopeSchema.safeParse(raw);
    if (!env.success) return;
    const handlers = topicHandlers.get(env.data.topic);
    if (handlers === undefined) return;
    for (const h of handlers) h(env.data.payload);
  });
}

/**
 * Subscribe to a topic. The first caller for a topic triggers the
 * over-the-wire `subscribe`; subsequent callers reuse it. Returns an
 * unsubscribe function that decrements the count and emits an
 * over-the-wire `unsubscribe` once it reaches zero.
 *
 * The handler receives **already-envelope-stripped** payloads. Decoding
 * (zod parse, schema validation) is the caller's responsibility — the
 * client is intentionally schema-agnostic so a new topic doesn't need a
 * client change.
 */
export function subscribeTopic(topic: SocketTopic, handler: TopicHandler): () => void {
  const socket = getSocket();
  installGlobalListener(socket);

  const handlers = topicHandlers.get(topic) ?? new Set<TopicHandler>();
  handlers.add(handler);
  topicHandlers.set(topic, handlers);

  const prevCount = refCounts.get(topic) ?? 0;
  refCounts.set(topic, prevCount + 1);
  if (prevCount === 0) {
    const onConnect = (): void => {
      socket.emit('subscribe', { topics: [topic] });
    };
    if (socket.connected) socket.emit('subscribe', { topics: [topic] });
    socket.on('connect', onConnect);
    reconnectHandlers.set(topic, onConnect);
  }

  return (): void => {
    const set = topicHandlers.get(topic);
    if (set !== undefined) {
      set.delete(handler);
      if (set.size === 0) topicHandlers.delete(topic);
    }
    const next = (refCounts.get(topic) ?? 1) - 1;
    if (next <= 0) {
      refCounts.delete(topic);
      const onConnect = reconnectHandlers.get(topic);
      if (onConnect !== undefined) {
        socket.off('connect', onConnect);
        reconnectHandlers.delete(topic);
      }
      if (socket.connected) socket.emit('unsubscribe', { topics: [topic] });
    } else {
      refCounts.set(topic, next);
    }
  };
}

/** Test-only — inspect the live ref count for a topic. */
export function _getTopicRefCount(topic: SocketTopic): number {
  return refCounts.get(topic) ?? 0;
}
