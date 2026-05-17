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

import { getClientConfig } from '../config/config-center-next-client-getter.js';

let socketSingleton: Socket | null = null;

function resolveUrl(): string {
  const socket = getClientConfig().socket;
  if (socket.url !== null) return socket.url;
  // `socket.url === null` means "compute at runtime"; ConfigCenter
  // already supplies the port default, so this only branches on the
  // browser-vs-server execution context, not on a missing config slot.
  if (typeof window === 'undefined') return `http://127.0.0.1:${socket.apiPort}`;
  return `${window.location.protocol}//${window.location.hostname}:${socket.apiPort}`;
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

// ─── command emit ────────────────────────────────────────────────────

interface SocketAck {
  readonly ok: boolean;
  readonly error?: string;
  readonly detail?: unknown;
}

/**
 * Fire a `{ id, args }` command at the gateway and wait for the ack.
 * Returns the ack object (`{ ok, error?, detail? }`) or rejects on
 * underlying socket transport failures (timeout, disconnect).
 *
 * Used by the term `/agent` command to kick off the BE loop —
 * everywhere else still goes through the BFF HTTP layer.
 */
export function sendSocketCommand(
  command: { readonly id: string; readonly args: Readonly<Record<string, unknown>> },
  timeoutMs = 30_000,
): Promise<SocketAck> {
  const socket = getSocket();
  return new Promise<SocketAck>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`socket command timed out after ${String(timeoutMs)}ms`));
    }, timeoutMs);
    socket.timeout(timeoutMs).emit('command', command, (err: unknown, ack: unknown) => {
      clearTimeout(timer);
      if (err !== null && err !== undefined) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (ack === null || typeof ack !== 'object') {
        resolve({ ok: false, error: 'malformed_ack' });
        return;
      }
      resolve(ack as SocketAck);
    });
  });
}
