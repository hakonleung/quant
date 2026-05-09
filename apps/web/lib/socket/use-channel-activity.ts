/**
 * Rolling buffer of the most recent `ChannelActivity` rows pushed onto
 * the `channel.activity` socket topic. Used by `feat-channel` to render
 * a unified system-push + inbound-IM feed.
 *
 * Buffer cap (`maxRows`) keeps long sessions from leaking memory; older
 * rows fall off the bottom (FIFO). `pending → sent/failed` updates are
 * folded onto the same activity id so the UI does not show two rows
 * for one logical send.
 */

'use client';

import { ChannelActivitySchema, SocketEnvelopeSchema, type ChannelActivity } from '@quant/shared';
import { useEffect, useState } from 'react';

import { getSocket } from './socket-client.js';

export interface ChannelActivityState {
  readonly status: 'connecting' | 'open' | 'error';
  readonly rows: readonly ChannelActivity[];
  readonly error: string | null;
}

const DEFAULT_MAX_ROWS = 500;

export function useChannelActivity(maxRows: number = DEFAULT_MAX_ROWS): ChannelActivityState {
  const [rows, setRows] = useState<readonly ChannelActivity[]>([]);
  const [status, setStatus] = useState<'connecting' | 'open' | 'error'>('connecting');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const socket = getSocket();

    const onEvent = (raw: unknown): void => {
      const env = SocketEnvelopeSchema.safeParse(raw);
      if (!env.success) return;
      if (env.data.topic !== 'channel.activity') return;
      const parsed = ChannelActivitySchema.safeParse(env.data.payload);
      if (!parsed.success) {
        setError(parsed.error.message);
        setStatus('error');
        return;
      }
      const incoming = parsed.data;
      setStatus('open');
      setError(null);
      setRows((prev) => {
        const idx = prev.findIndex((r) => baseId(r.id) === baseId(incoming.id));
        const next =
          idx >= 0
            ? [...prev.slice(0, idx), incoming, ...prev.slice(idx + 1)]
            : [incoming, ...prev];
        return next.length > maxRows ? next.slice(0, maxRows) : next;
      });
    };

    const onConnect = (): void => {
      socket.emit('subscribe', { topics: ['channel.activity'] });
      setStatus('open');
    };
    const onDisconnect = (): void => {
      setStatus('error');
      setError('disconnected');
    };

    if (socket.connected) {
      socket.emit('subscribe', { topics: ['channel.activity'] });
      setStatus('open');
    }
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('event', onEvent);

    return (): void => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('event', onEvent);
      if (socket.connected) {
        socket.emit('unsubscribe', { topics: ['channel.activity'] });
      }
    };
  }, [maxRows]);

  return { status, rows, error };
}

/** Strip the worker's `:done`/`:err`/`:failed` suffix so pending and
 *  resolved rows fold into one. */
function baseId(id: string): string {
  const colon = id.lastIndexOf(':');
  if (colon < 0) return id;
  const tail = id.slice(colon + 1);
  if (tail === 'done' || tail === 'err' || tail === 'failed') return id.slice(0, colon);
  return id;
}
