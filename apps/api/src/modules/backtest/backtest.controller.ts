/**
 * HTTP routes for screen-signal backtesting.
 *
 *   POST /api/backtest/evaluate-signals          → BacktestEvaluateResponse
 *   POST /api/backtest/evaluate-screen           → BacktestEvaluateResponse
 *   POST /api/backtest/evaluate-screen/stream    → text/event-stream
 *
 * The /stream variant emits one `data: <json>\n\n` event per processed
 * weekday plus a final `result` event carrying the same response. The
 * FE uses it to render a progress bar while the per-day screen loop is
 * running (250-day windows can take 30+ seconds).
 *
 * Why POST + manual text/event-stream rather than NestJS @Sse: @Sse only
 * supports GET, and the screen plan AST is too large to put in a query
 * string. We bypass passthrough so we own the Response writes directly.
 */

import { Body, Controller, Inject, NotFoundException, Post, Req, Res } from '@nestjs/common';
import {
  BacktestEvaluateScreenRequestSchema,
  BacktestEvaluateSignalsRequestSchema,
  type BacktestEvaluateResponse,
  type BacktestEvaluateScreenRequest,
  type BacktestEvaluateSignalsRequest,
} from '@quant/shared';
import type { Request, Response } from 'express';

import { ZodValidationPipe } from '../../common/zod-pipe.js';
import { BacktestService, type ScreenProgressEvent } from './backtest.service.js';

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

  /**
   * Cache-only read (mirrors `GET /api/sentiment/analyze_one`). 200 +
   * response on hit, 404 on miss. The FE calls this on mount to show
   * the prior run instantly; on 404 it falls back to `/stream`.
   *
   * POST + body rather than GET + query because the request carries a
   * full screen AST that doesn't fit in a URL.
   */
  @Post('evaluate-screen/cached')
  async getCachedScreen(
    @Body(screenPipe) body: BacktestEvaluateScreenRequest,
  ): Promise<BacktestEvaluateResponse> {
    const cached = await this.backtest.getCachedScreen(body);
    if (cached === null) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'no cached backtest result for this (plan, window, holdings)',
      });
    }
    return cached;
  }

  @Post('evaluate-screen/stream')
  async evaluateScreenStream(
    @Req() req: Request,
    @Body(screenPipe) body: BacktestEvaluateScreenRequest,
    @Res() res: Response,
  ): Promise<void> {
    const traceId = (req as Request & { traceId?: string }).traceId ?? '';
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const writeEvent = (payload: unknown): void => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    const onProgress = (ev: ScreenProgressEvent): void => {
      writeEvent({ type: 'progress', ...ev });
    };

    try {
      const result = await this.backtest.evaluateScreen(body, traceId, onProgress);
      writeEvent({ type: 'result', payload: result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      writeEvent({ type: 'error', message: msg });
    } finally {
      res.end();
    }
  }
}
