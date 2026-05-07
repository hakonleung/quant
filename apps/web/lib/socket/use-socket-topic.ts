/**
 * Generic hook over a Socket.IO topic.
 *
 *   const state = useSocketTopic('watch.snapshot', WatchSnapshotPayloadSchema);
 *
 * Lifecycle:
 *   - on mount: emit `subscribe { topics: [topic] }` on the singleton
 *     socket, register an `event` listener that filters by topic, parse
 *     the payload via the supplied zod schema, and yield it.
 *   - on unmount: emit `unsubscribe` and remove the listener so a
 *     remounted hook does not double-subscribe.
 *
 * Connection status (`connecting | open | error`) drives the FeatView
 * status dot uniformly across panes.
 */

'use client';

import { SocketEnvelopeSchema, type SocketTopic } from '@quant/shared';
import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';

import { getSocket } from './socket-client.js';

export type SocketStreamState<T> =
  | { readonly status: 'connecting'; readonly snapshot: null }
  | { readonly status: 'open'; readonly snapshot: T }
  | { readonly status: 'error'; readonly snapshot: T | null; readonly message: string };

export function useSocketTopic<S extends z.ZodTypeAny>(
  topic: SocketTopic,
  schema: S,
): SocketStreamState<z.infer<S>> {
  type T = z.infer<S>;
  const [state, setState] = useState<SocketStreamState<T>>({
    status: 'connecting',
    snapshot: null,
  });
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const socket = getSocket();

    const onEvent = (raw: unknown): void => {
      const env = SocketEnvelopeSchema.safeParse(raw);
      if (!env.success) return;
      if (env.data.topic !== topic) return;
      const parsed = schema.safeParse(env.data.payload);
      if (!parsed.success) {
        setState((prev) => ({
          status: 'error',
          snapshot: prev.status === 'open' ? prev.snapshot : null,
          message: parsed.error.message,
        }));
        return;
      }
      setState({ status: 'open', snapshot: parsed.data });
    };

    const onConnect = (): void => {
      socket.emit('subscribe', { topics: [topic] });
    };
    const onDisconnect = (): void => {
      setState((prev) => ({
        status: 'error',
        snapshot: prev.status === 'open' ? prev.snapshot : null,
        message: 'disconnected',
      }));
    };

    if (socket.connected) {
      socket.emit('subscribe', { topics: [topic] });
    }
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('event', onEvent);

    return (): void => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('event', onEvent);
      if (socket.connected) {
        socket.emit('unsubscribe', { topics: [topic] });
      }
    };
  }, [topic, schema]);

  return state;
}
