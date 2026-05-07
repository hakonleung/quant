/**
 * Live `QueueSnapshot` over the unified Socket.IO bus
 * (`docs/modules/12-socket.md`). Replaces the old
 * `EventSource('/api/orchestration/queue/stream')` SSE consumer; the
 * exposed shape is unchanged so callers stay agnostic to the
 * underlying transport.
 */

'use client';

import { QueueSnapshotSchema, type QueueSnapshot } from '@quant/shared';

import { useSocketTopic } from '../socket/use-socket-topic.js';

export type QueueStreamState =
  | { readonly status: 'connecting'; readonly snapshot: null }
  | { readonly status: 'open'; readonly snapshot: QueueSnapshot }
  | { readonly status: 'error'; readonly snapshot: QueueSnapshot | null };

export function useQueueStream(): QueueStreamState {
  const state = useSocketTopic('queue.snapshot', QueueSnapshotSchema);
  if (state.status === 'open') return { status: 'open', snapshot: state.snapshot };
  if (state.status === 'connecting') return { status: 'connecting', snapshot: null };
  return { status: 'error', snapshot: state.snapshot };
}
