/**
 * Browser API surface for the EQTY workbench. Each function calls the
 * NestJS gateway and validates the response with the shared zod schema
 * (CLAUDE.md §2.7). Endpoints not yet backed by a real Python service
 * resolve to `[]` / `null` via `safeGet` so the UI renders an empty
 * state without crashing — TODOs on the gateway controllers track the
 * remaining wiring.
 */

import {
  KlineBarSchema,
  MarketSentimentSchema,
  NlScreenResultSchema,
  SentimentSchema,
  StockMetaDtoSchema,
  type KlineBar,
  type MarketSentiment,
  type NlScreenResult,
  type Sentiment,
  type StockMetaDto,
} from '@quant/shared';
import { z } from 'zod';

import { apiGet, apiPost } from './client.js';

const arr = <S extends z.ZodTypeAny>(schema: S): z.ZodArray<S> => z.array(schema);

/**
 * Returns `null` when the gateway is up but the upstream Python Flight
 * server is unreachable / the row is missing. The UI degrades to a "—"
 * placeholder; explicit errors must be surfaced via the dev-tools
 * network panel rather than a render-blocking exception.
 */
export async function getStockMeta(code: string): Promise<StockMetaDto | null> {
  return safeOne(`/api/stocks/${encodeURIComponent(code)}`, StockMetaDtoSchema);
}

export async function listKline(code: string, range: string): Promise<readonly KlineBar[]> {
  return safeList(
    `/api/kline/${encodeURIComponent(code)}?range=${encodeURIComponent(range)}`,
    KlineBarSchema,
  );
}

/**
 * Cached read for the EQTY page's default render path. Returns `null`
 * when no cache row exists (404) so the panel can show "no analysis
 * yet" without throwing.
 */
export async function getCachedSentiment(code: string): Promise<Sentiment | null> {
  return safeOne(
    `/api/sentiment/analyze_one?code=${encodeURIComponent(code)}`,
    SentimentSchema,
  );
}

/**
 * Trigger a fresh sentiment analysis for `code`. Always a POST — this
 * route writes to the cache server-side, kicks off the LLM workflow,
 * and returns the resulting `Sentiment`. The caller is expected to
 * invalidate the cached-read query on success (see
 * {@link useAnalyzeSentiment}).
 */
export async function analyzeSentiment(code: string): Promise<Sentiment> {
  return apiPost(
    `/api/sentiment/analyze_one`,
    { code },
    (raw) => SentimentSchema.parse(raw),
  );
}

/**
 * Cached aggregate read for a sector / watchlist. Returns `null` on
 * cache miss so the UI shows "no analysis yet" without throwing.
 */
export async function getCachedMarketSentiment(
  codes: readonly string[],
): Promise<MarketSentiment | null> {
  if (codes.length === 0) return null;
  const q = codes.map(encodeURIComponent).join(',');
  return safeOne(`/api/sentiment/analyze_many?codes=${q}`, MarketSentimentSchema);
}

/**
 * Trigger a fresh multi-stock analysis (paid LLM call). The caller
 * should `invalidateQueries` for the matching cached-read key on
 * success so the GET query re-fetches the warm cache.
 */
/**
 * Run the NL → DSL → screen pipeline. Returns both the matched stocks
 * AND the parsed AST so the UI can show "this is how the parser
 * understood your sentence" alongside the result.
 */
export async function runNlScreen(
  nl: string,
  asof?: string,
): Promise<NlScreenResult> {
  return apiPost(
    `/api/screen/nl`,
    asof === undefined ? { nl } : { nl, asof },
    (raw) => NlScreenResultSchema.parse(raw),
  );
}

export async function analyzeManySentiment(
  codes: readonly string[],
): Promise<MarketSentiment> {
  return apiPost(
    `/api/sentiment/analyze_many`,
    { codes: [...codes] },
    (raw) => MarketSentimentSchema.parse(raw),
  );
}

async function safeList<T>(path: string, schema: z.ZodType<T>): Promise<readonly T[]> {
  try {
    return await apiGet(path, (raw) => arr(schema).parse(raw));
  } catch {
    return [];
  }
}

async function safeOne<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
  try {
    return await apiGet(path, (raw) => schema.parse(raw));
  } catch {
    return null;
  }
}
