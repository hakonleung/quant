'use client';

import {
  BacktestEvaluateResponseSchema,
  type BacktestEvaluateResponse,
  type BacktestEvaluateScreenRequest,
  type BacktestEvaluateSignalsRequest,
} from '@quant/shared';
import { useMutation, useQuery, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';

import {
  streamEvaluateBacktestScreen,
  type ScreenProgressEvent,
} from '../api/backtest-stream.js';
import { evaluateBacktestSignals } from '../api/endpoints.js';

/**
 * Streaming mutation hook for the screen backtest. Surfaces per-day
 * progress via `progress` while the request is in flight so the UI can
 * render a deterministic progress bar (250-day windows take 30+ s).
 *
 * `progress` is `null` until the first event arrives, then sticks at
 * the last received event. It resets to `null` on each new `mutate()`.
 */
export interface UseBacktestScreenResult {
  readonly mutation: UseMutationResult<
    BacktestEvaluateResponse,
    Error,
    BacktestEvaluateScreenRequest
  >;
  readonly progress: ScreenProgressEvent | null;
  readonly cancel: () => void;
}

export function useBacktestScreen(): UseBacktestScreenResult {
  const [progress, setProgress] = useState<ScreenProgressEvent | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const mutationFn = useCallback(
    async (req: BacktestEvaluateScreenRequest): Promise<BacktestEvaluateResponse> => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setProgress(null);
      return streamEvaluateBacktestScreen(req, {
        onProgress: setProgress,
        signal: controller.signal,
      });
    },
    [],
  );

  const mutation = useMutation({
    mutationKey: ['backtest.screen.stream'],
    mutationFn,
  });

  const cancel = useCallback((): void => {
    abortRef.current?.abort();
  }, []);

  return { mutation, progress, cancel };
}

/**
 * Cache-only read of `POST /api/backtest/evaluate-screen/cached`. The
 * pane calls this on mount + whenever the request inputs change, so a
 * previously computed (plan, window, holdings) shows up instantly. A
 * 404 resolves to `null` (no error) — the pane treats it as the "press
 * RUN to compute" empty state.
 *
 * `enabled` lets the caller skip the fetch entirely until the
 * sector / inputs are valid.
 */
export function useBacktestScreenCached(
  req: BacktestEvaluateScreenRequest | null,
  enabled: boolean,
): UseQueryResult<BacktestEvaluateResponse | null> {
  return useQuery({
    queryKey: ['backtest.screen.cached', req],
    enabled: enabled && req !== null,
    staleTime: 60_000,
    queryFn: async (): Promise<BacktestEvaluateResponse | null> => {
      if (req === null) throw new Error('queryFn called with null req');
      const res = await fetch('/api/backtest/evaluate-screen/cached', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`/api/backtest/evaluate-screen/cached → ${String(res.status)}`);
      }
      const raw: unknown = await res.json();
      return BacktestEvaluateResponseSchema.parse(raw);
    },
  });
}

/**
 * Primitive variant unchanged — caller already has the signal stream,
 * so there's nothing per-day to stream and the synchronous endpoint is
 * fine. Returned with the same outer shape for call-site symmetry.
 */
export function useBacktestSignals(): UseMutationResult<
  BacktestEvaluateResponse,
  Error,
  BacktestEvaluateSignalsRequest
> {
  return useMutation({
    mutationKey: ['backtest.signals'],
    mutationFn: (req) => evaluateBacktestSignals(req),
  });
}
