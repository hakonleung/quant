/**
 * HTTP routes for screen-signal backtesting.
 *
 *   POST /api/backtest/evaluate-signals  { signals, holdings }
 *     → BacktestEvaluateResponse
 *
 *   POST /api/backtest/evaluate-screen   { screenPlan, universePlan?, rank?,
 *                                          startDate, endDate, holdings }
 *     → BacktestEvaluateResponse
 *
 * Both routes return the same payload: per-holding return distribution
 * + raw observations. The `evaluate-screen` route is a thin wrapper
 * that iterates trading days in [startDate, endDate], runs the screen
 * for each, then folds the matched (date, code) pairs into the
 * primitive `evaluate-signals` path.
 */

import { Body, Controller, Inject, Post, Req } from '@nestjs/common';
import {
  BacktestEvaluateScreenRequestSchema,
  BacktestEvaluateSignalsRequestSchema,
  type BacktestEvaluateResponse,
  type BacktestEvaluateScreenRequest,
  type BacktestEvaluateSignalsRequest,
} from '@quant/shared';
import type { Request } from 'express';

import { ZodValidationPipe } from '../../common/zod-pipe.js';
import { BacktestService } from './backtest.service.js';

const signalsPipe = new ZodValidationPipe(BacktestEvaluateSignalsRequestSchema);
const screenPipe = new ZodValidationPipe(BacktestEvaluateScreenRequestSchema);

@Controller('backtest')
export class BacktestController {
  constructor(@Inject(BacktestService) private readonly backtest: BacktestService) {}

  @Post('evaluate-signals')
  async evaluateSignals(
    @Req() req: Request,
    @Body(signalsPipe) body: BacktestEvaluateSignalsRequest,
  ): Promise<BacktestEvaluateResponse> {
    const traceId = (req as Request & { traceId?: string }).traceId ?? '';
    return this.backtest.evaluateSignals(body, traceId);
  }

  @Post('evaluate-screen')
  async evaluateScreen(
    @Req() req: Request,
    @Body(screenPipe) body: BacktestEvaluateScreenRequest,
  ): Promise<BacktestEvaluateResponse> {
    const traceId = (req as Request & { traceId?: string }).traceId ?? '';
    return this.backtest.evaluateScreen(body, traceId);
  }
}
