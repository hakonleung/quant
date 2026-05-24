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
  inferMarketFromCode,
  QuantError,
  type InstructionCell,
  type ResultOf,
} from '@quant/shared';

import { NewsSentimentService } from '../../sentiment/news-sentiment.service.js';
import { StockMetaService } from '../../stock-meta/stock-meta.service.js';
import type { BeEnv } from '../be-types.js';
import { renderAnalyze } from './analyze.render.js';

type AnalyzeResult = ResultOf<'analyze'>;

export interface AnalyzeCellDeps {
  readonly sentiment: NewsSentimentService;
  readonly stockMeta: StockMetaService;
}

/**
 * IM ergonomics: users type `/分析 埃科光电` (the stock name) more often
 * than a 6-digit code. If the input already matches a wire form
 * (A/HK/US), pass it through. Otherwise search A-share metadata by
 * exact name match (case-insensitive on pinyin too). Returns `null`
 * when nothing matched — caller decides whether to throw or fall
 * through. HK/US name resolution isn't supported (no meta source).
 */
async function resolveCode(
  raw: string,
  stockMeta: StockMetaService,
  traceId: string,
): Promise<string | null> {
  if (inferMarketFromCode(raw) !== null) return raw;
  const all = await stockMeta.listAll(traceId);
  const needle = raw.toLowerCase();
  const hit = all.find(
    (m) => m.name === raw || m.name.toLowerCase() === needle || m.name_pinyin.toLowerCase() === needle,
  );
  return hit?.code ?? null;
}

export function buildAnalyzeCell(deps: AnalyzeCellDeps): InstructionCell<BeEnv, 'analyze'> {
  return {
    async handler(args, ctx): Promise<AnalyzeResult> {
      const code = await resolveCode(args.code, deps.stockMeta, ctx.traceId);
      if (code === null) {
        throw new QuantError(
          'INVALID_ARGUMENT',
          `unknown code or name: ${args.code} (expected A/HK/US wire code or A-share name)`,
          { code: args.code },
        );
      }
      try {
        return await deps.sentiment.analyzeOne(
          {
            code,
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
    async peek(rawArgs, ctx) {
      const parsed = AnalyzeArgsSchema.safeParse(rawArgs);
      if (!parsed.success) return false;
      if (parsed.data.fresh) return false;
      const windowDays = parsed.data.windowDays ?? 30;
      try {
        const code = await resolveCode(parsed.data.code, deps.stockMeta, ctx.traceId);
        if (code === null) return false;
        const cached = await deps.sentiment.getCachedStock(code, windowDays);
        return cached !== null;
      } catch {
        return false;
      }
    },
  };
}
