/**
 * `/analyze <code>` cell — single-stock news sentiment via the
 * paid LLM pipeline. First migrated async + IM-confirmed instruction.
 *
 * Handler: invokes `NewsSentimentService.analyzeOne` with
 * `bypassCache` / `windowDays` flags from args; returns the typed
 * `Sentiment` payload. `QuantError` throws are converted into the
 * `handler` error envelope by the executor; other throws propagate
 * (they reach the async-job logger).
 *
 * Renderer: pure, see `analyze.render.ts`.
 *
 * Peek: IM paid-confirm bypass — when `fresh=false` and a fresh
 * cache hit exists for `(code, windowDays || 30)`, skip the confirm
 * card. Probe failures fall closed (`false`).
 */

import {
  AnalyzeArgsSchema,
  QuantError,
  type InstructionCell,
  type ResultOf,
} from '@quant/shared';

import { NewsSentimentService } from '../../sentiment/news-sentiment.service.js';
import type { BeEnv } from '../be-types.js';
import { renderAnalyze } from './analyze.render.js';

type AnalyzeResult = ResultOf<'analyze'>;

export interface AnalyzeCellDeps {
  readonly sentiment: NewsSentimentService;
}

export function buildAnalyzeCell(deps: AnalyzeCellDeps): InstructionCell<BeEnv, 'analyze'> {
  return {
    async handler(args, ctx): Promise<AnalyzeResult> {
      try {
        return await deps.sentiment.analyzeOne(
          {
            market: 'a',
            code: args.code,
            ...(args.fresh ? { bypassCache: true } : {}),
            ...(args.windowDays !== undefined ? { windowDays: args.windowDays } : {}),
          },
          { userId: ctx.userId, traceId: ctx.traceId },
        );
      } catch (err) {
        // Domain failures (`QuantError`) become the cell's error envelope
        // (executor wraps to `handler` code); other throws propagate so
        // the async-job logger sees them with the stack.
        if (err instanceof QuantError) throw err;
        throw err;
      }
    },
    renderer(envelope) {
      return renderAnalyze(envelope);
    },
    async peek(rawArgs) {
      const parsed = AnalyzeArgsSchema.safeParse(rawArgs);
      if (!parsed.success) return false;
      if (parsed.data.fresh) return false;
      const windowDays = parsed.data.windowDays ?? 30;
      try {
        const cached = await deps.sentiment.getCachedStock('a', parsed.data.code, windowDays);
        return cached !== null;
      } catch {
        return false;
      }
    },
  };
}
