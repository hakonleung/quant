/**
 * SSE consumer for `/api/orchestration/queue/stream`.
 *
 * Hits the same-origin Next BFF — the BFF proxies to the NestJS SSE
 * endpoint (modules/07-frontend.md §防腐层). The endpoint emits one
 * `QueueSnapshot` per second; the hook validates each event with the
 * shared zod schema before yielding it.
 */

'use client';

import { QueueSnapshotSchema, type QueueSnapshot } from '@quant/shared';
import { useEffect, useState } from 'react';

export type QueueStreamState =
  | { readonly status: 'connecting'; readonly snapshot: null }
  | { readonly status: 'open'; readonly snapshot: QueueSnapshot }
  | { readonly status: 'error'; readonly snapshot: QueueSnapshot | null };

export function useQueueStream(): QueueStreamState {
  const [state, setState] = useState<QueueStreamState>({ status: 'connecting', snapshot: null });

  useEffect(() => {
    const es = new EventSource('/api/orchestration/queue/stream');

    es.onmessage = (ev: MessageEvent<string>): void => {
      try {
        const raw: unknown = JSON.parse(ev.data);
        const parsed = QueueSnapshotSchema.parse(raw);
        setState({ status: 'open', snapshot: parsed });
      } catch {
        // Drop malformed frames; the next tick refreshes.
      }
    };

    es.onerror = (): void => {
      setState((prev) => ({ status: 'error', snapshot: prev.snapshot }));
    };

    return (): void => {
      es.close();
    };
  }, []);

  return state;
}
