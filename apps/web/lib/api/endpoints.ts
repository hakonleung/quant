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
  LedgerAnalysisSchema,
  LedgerEntrySchema,
  LedgerSnapshotSchema,
  MarketSentimentSchema,
  NlScreenResultSchema,
  NlToDslResultSchema,
  PatternFindSimilarResponseSchema,
  ScreenRunResultSchema,
  SentimentSchema,
  StockMetaDtoSchema,
  StockSnapshotDtoSchema,
  TaAnalysisSchema,
  TaSectorAnalysisSchema,
  type KlineBar,
  type LedgerAnalysis,
  type LedgerEntry,
  type LedgerSnapshot,
  type MarketSentiment,
  type NlScreenResult,
  type NlToDslResult,
  type PatternFindSimilarRequest,
  type PatternFindSimilarResponse,
  type RankSpecView,
  type ScreenPlanAst,
  type ScreenRunResult,
  type Sentiment,
  type StockMetaDto,
  type StockSnapshotDto,
  type TaAnalysis,
  type TaSectorAnalysis,
  type UniversePlanAst,
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

const KlineBulkSchema = z.record(z.string(), z.array(KlineBarSchema));
export type KlineBulkResponse = z.infer<typeof KlineBulkSchema>;

/**
 * Bulk last-N read. Pass empty `codes` to fetch the full universe
 * (server expands to every stock-meta code). Codes whose parquet is
 * missing are simply absent from the response — never a 404.
 */
export async function listKlineBulk(
  codes: readonly string[],
  n: number,
): Promise<KlineBulkResponse> {
  const q = codes.length === 0 ? '' : codes.map(encodeURIComponent).join(',');
  try {
    return await apiGet(`/api/kline/bulk?codes=${q}&n=${String(n)}`, (raw) =>
      KlineBulkSchema.parse(raw),
    );
  } catch {
    return {};
  }
}

/**
 * meta + price-derived metrics for the given codes. Mirrors
 * `listKlineBulk` semantics: an empty `codes` array means **the full
 * universe** (server expands to every stock-meta code). The previous
 * "empty → []" short-circuit silently broke EQ.LIST whenever the active
 * sector held more codes than the URL line could carry — for the
 * synthetic `All` sector we now emit one Flight call instead of
 * stuffing ~5500 codes into a 30 KB query string.
 */
export async function listStockSnapshots(
  codes: readonly string[],
): Promise<readonly StockSnapshotDto[]> {
  const q = codes.length === 0 ? '' : codes.map(encodeURIComponent).join(',');
  return safeList(`/api/stocks/snapshots?codes=${q}`, StockSnapshotDtoSchema);
}

/**
 * Cached read for the EQTY page's default render path. Returns `null`
 * when no cache row exists (404) so the panel can show "no analysis
 * yet" without throwing.
 */
export async function getCachedSentiment(code: string): Promise<Sentiment | null> {
  return safeOne(`/api/sentiment/analyze_one?code=${encodeURIComponent(code)}`, SentimentSchema);
}

/**
 * Trigger a fresh sentiment analysis for `code`. Always a POST — this
 * route writes to the cache server-side, kicks off the LLM workflow,
 * and returns the resulting `Sentiment`. The caller is expected to
 * invalidate the cached-read query on success (see
 * {@link useAnalyzeSentiment}).
 */
export async function analyzeSentiment(code: string): Promise<Sentiment> {
  return apiPost(`/api/sentiment/analyze_one`, { code }, (raw) => SentimentSchema.parse(raw));
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
export async function runNlScreen(nl: string, asof?: string): Promise<NlScreenResult> {
  return apiPost(`/api/screen/nl`, asof === undefined ? { nl } : { nl, asof }, (raw) =>
    NlScreenResultSchema.parse(raw),
  );
}

/** Translate NL → AST without executing the screen. */
export async function nlToDsl(nl: string, asof?: string): Promise<NlToDslResult> {
  return apiPost(`/api/screen/nl2dsl`, asof === undefined ? { nl } : { nl, asof }, (raw) =>
    NlToDslResultSchema.parse(raw),
  );
}

/** Execute an AST against the K-line cache (no LLM call). */
export async function runScreen(args: {
  readonly screenPlan: ScreenPlanAst;
  readonly universePlan?: UniversePlanAst | null;
  readonly rank?: RankSpecView | null;
}): Promise<ScreenRunResult> {
  const body: Record<string, unknown> = { screenPlan: args.screenPlan };
  if (args.universePlan !== undefined && args.universePlan !== null) {
    body['universePlan'] = args.universePlan;
  }
  if (args.rank !== undefined && args.rank !== null) {
    body['rank'] = args.rank;
  }
  return apiPost(`/api/screen/run`, body, (raw) => ScreenRunResultSchema.parse(raw));
}

export async function findSimilarPatterns(
  req: PatternFindSimilarRequest,
): Promise<PatternFindSimilarResponse> {
  return apiPost(`/api/pattern/find_similar`, req, (raw) =>
    PatternFindSimilarResponseSchema.parse(raw),
  );
}

export async function analyzeManySentiment(codes: readonly string[]): Promise<MarketSentiment> {
  return apiPost(`/api/sentiment/analyze_many`, { codes: [...codes] }, (raw) =>
    MarketSentimentSchema.parse(raw),
  );
}

/**
 * Cached read for the technical-analysis (beta) feature. Returns `null`
 * on miss so the terminal can decide between rendering "no analysis
 * yet" and forcing a fresh LLM call.
 */
export async function getCachedTaAnalysis(code: string): Promise<TaAnalysis | null> {
  return safeOne(`/api/ta/analyze_one?code=${encodeURIComponent(code)}`, TaAnalysisSchema);
}

/** Trigger a fresh TA analysis (paid LLM call). */
export async function analyzeTa(code: string, bypassCache = false): Promise<TaAnalysis> {
  return apiPost(`/api/ta/analyze_one`, bypassCache ? { code, bypassCache } : { code }, (raw) =>
    TaAnalysisSchema.parse(raw),
  );
}

/** Sector-level TA fan-out + LLM summary (paid). */
export async function analyzeTaMany(
  codes: readonly string[],
  label?: string,
): Promise<TaSectorAnalysis> {
  const body: { codes: string[]; label?: string } = { codes: [...codes] };
  if (label !== undefined) body.label = label;
  return apiPost(`/api/ta/analyze_many`, body, (raw) => TaSectorAnalysisSchema.parse(raw));
}

// ---------- ledger ----------

const LedgerEntryListSchema = z.array(LedgerEntrySchema);

export async function listLedgerEntries(): Promise<readonly LedgerEntry[]> {
  return safeList(`/api/ledger`, LedgerEntrySchema);
}

export async function createLedgerEntry(entry: LedgerEntry): Promise<LedgerEntry> {
  return apiPost(`/api/ledger`, entry, (raw) => LedgerEntrySchema.parse(raw));
}

export async function patchLedgerEntry(
  date: string,
  body: { pnlAmount?: string; closingPosition?: string | null },
): Promise<LedgerEntry> {
  // Spread is the cleanest way to satisfy `exactOptionalPropertyTypes:true`
  // — fields stay omitted instead of explicitly `undefined`.
  const payload: Record<string, unknown> = {};
  if (body.pnlAmount !== undefined) payload['pnlAmount'] = body.pnlAmount;
  if (Object.prototype.hasOwnProperty.call(body, 'closingPosition')) {
    payload['closingPosition'] = body.closingPosition ?? null;
  }
  return apiPatch(`/api/ledger/${encodeURIComponent(date)}`, payload, (raw) =>
    LedgerEntrySchema.parse(raw),
  );
}

export async function deleteLedgerEntry(date: string): Promise<void> {
  await apiDelete(`/api/ledger/${encodeURIComponent(date)}`);
}

export async function importLedger(entries: readonly LedgerEntry[]): Promise<LedgerSnapshot> {
  return apiPost(`/api/ledger/import`, { entries: [...entries] }, (raw) =>
    LedgerSnapshotSchema.parse(raw),
  );
}

/** Direct download — does not parse, returns the URL the browser should hit. */
export const LEDGER_EXPORT_URL = '/api/ledger/export';

export async function getCachedLedgerAnalysis(): Promise<LedgerAnalysis | null> {
  return safeOne(`/api/ledger/analyze`, LedgerAnalysisSchema);
}

export async function analyzeLedger(bypassCache = false): Promise<LedgerAnalysis> {
  return apiPost(`/api/ledger/analyze`, bypassCache ? { bypassCache } : {}, (raw) =>
    LedgerAnalysisSchema.parse(raw),
  );
}

// ledger entry-list export for callers that want to revalidate their cache
// without parsing the raw entries again.
export { LedgerEntryListSchema };

async function apiPatch<T>(path: string, body: unknown, parse: (raw: unknown) => T): Promise<T> {
  const res = await fetch(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → ${String(res.status)}`);
  return parse((await res.json()) as unknown);
}

async function apiDelete(path: string): Promise<void> {
  const res = await fetch(path, { method: 'DELETE' });
  if (!res.ok) throw new Error(`${path} → ${String(res.status)}`);
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
