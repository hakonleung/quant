'use client';

import type {
  BacktestEvaluateResponse,
  BacktestEvaluateScreenRequest,
  BacktestEvaluateSignalsRequest,
} from '@quant/shared';
import { useMutation, type UseMutationResult } from '@tanstack/react-query';
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
