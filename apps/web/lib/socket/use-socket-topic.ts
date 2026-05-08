/**
 * Generic hook over a Socket.IO topic.
 *
 *   const state = useSocketTopic('watch.snapshot', WatchSnapshotPayloadSchema);
 *
 * Lifecycle (handled by the singleton in `socket-client.ts`):
 *   - on mount: bump the topic's ref count; the first subscriber emits
 *     `subscribe { topics: [topic] }`, later ones piggy-back. The
 *     dispatcher fans events out to every per-topic handler.
 *   - on unmount: decrement; the final unsubscriber emits
 *     `unsubscribe`, so no stale subscription survives a fast
 *     remount/unmount cycle.
 *
 * Schema identity (the second argument) is intentionally **not** in the
 * effect dependency list — schemas are typically module-level constants
 * but callers occasionally inline `z.object(...)`, which would otherwise
 * tear the socket subscription down on every render. The hook reads
 * the latest schema through a ref so each event uses the current value
 * without paying for a subscribe / unsubscribe round-trip.
 */

'use client';

import { type SocketTopic } from '@quant/shared';
import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';

import { getSocket, subscribeTopic } from './socket-client.js';

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

  // Always validate against the latest schema reference without forcing
  // a new subscription when the caller passes an inline schema literal.
  const schemaRef = useRef(schema);
  schemaRef.current = schema;

  useEffect(() => {
    const socket = getSocket();
    const unsubscribe = subscribeTopic(topic, (payload) => {
      const parsed: z.SafeParseReturnType<unknown, T> = schemaRef.current.safeParse(payload);
      if (!parsed.success) {
        setState((prev) => ({
          status: 'error',
          snapshot: prev.status === 'open' ? prev.snapshot : null,
          message: parsed.error.message,
        }));
        return;
      }
      setState({ status: 'open', snapshot: parsed.data });
    });

    const onDisconnect = (): void => {
      setState((prev) => ({
        status: 'error',
        snapshot: prev.status === 'open' ? prev.snapshot : null,
        message: 'disconnected',
      }));
    };
    socket.on('disconnect', onDisconnect);

    return (): void => {
      socket.off('disconnect', onDisconnect);
      unsubscribe();
    };
  }, [topic]);

  return state;
}
