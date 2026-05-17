'use client';

import type {
  BacktestEvaluateResponse,
  BacktestEvaluateScreenRequest,
  BacktestEvaluateSignalsRequest,
} from '@quant/shared';
import { useMutation, type UseMutationResult } from '@tanstack/react-query';

import { evaluateBacktestScreen, evaluateBacktestSignals } from '../api/endpoints.js';

/**
 * Mutation hook for the screen-signal backtest. Each call iterates
 * trading days under the hood (NestJS does the loop + Python does the
 * distribution math), so latency scales with the date window — a 250-
 * day window can take tens of seconds. The caller decides when to
 * trigger by gating on a button click rather than auto-fetching.
 */
export function useBacktestScreen(): UseMutationResult<
  BacktestEvaluateResponse,
  Error,
  BacktestEvaluateScreenRequest
> {
  return useMutation({
    mutationKey: ['backtest.screen'],
    mutationFn: (req) => evaluateBacktestScreen(req),
  });
}

/**
 * Primitive variant: caller already has the (signalDate, code) stream
 * (e.g. dumped from a CSV / external source) and only wants the
 * distribution stats.
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
