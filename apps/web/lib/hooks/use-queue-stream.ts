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
    let es: EventSource | null = null;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryDelay = 1000;

    const open = (): void => {
      if (cancelled) return;
      es = new EventSource('/api/orchestration/queue/stream');
      es.onopen = (): void => {
        retryDelay = 1000;
      };
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
        // Browser EventSource auto-reconnects on most network blips —
        // CLOSED means it gave up, in which case we own the retry. Any
        // other state means the browser is already retrying; just
        // surface the transient error to the UI.
        if (es?.readyState === EventSource.CLOSED) {
          es.close();
          es = null;
          setState((prev) => ({ status: 'error', snapshot: prev.snapshot }));
          retryTimer = setTimeout(open, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 15000);
        } else {
          setState((prev) => ({ status: 'error', snapshot: prev.snapshot }));
        }
      };
    };

    open();

    return (): void => {
      cancelled = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      es?.close();
    };
  }, []);

  return state;
}
