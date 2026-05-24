/**
 * NestJS-side news-sentiment pipeline.
 *
 * Per-stock pipeline (`analyzeOne`) — single LLM call:
 *   1. meta lookup (`STOCK_NOT_FOUND` if missing).
 *   2. cache hit by (code, asof, windowDays) → return immediately.
 *   3. `LlmService.completeJsonWithWebSearch` — one shot, web search +
 *      JSON output combined. No "analyst notes" intermediate, no retry
 *      on parse failure (callers see an `LLM_FAILED` and may try
 *      `--fresh` again).
 *   4. Decode the compact `|`-separated string wire into a typed
 *      `Sentiment` (see `domain/pure/parsers.ts`).
 *   5. write through cache.
 *
 * Multi-stock (`analyzeMany`):
 *   1. fan out per-stock (Promise.allSettled, bounded by codes cap = 200).
 *   2. theme cluster pass (`LlmService.completeJson`, no web search).
 *   3. market synth pass (`LlmService.completeJson`, no web search).
 *   4. write through market cache.
 *
 * Failures on individual codes during `analyzeMany` collapse to caveats;
 * the call succeeds as long as ≥ 1 stock returned a payload.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  type IndustryTrend,
  inferMarketFromCode,
  MarketSentimentSchema,
  type MarketSentiment,
  QuantError,
  type Sentiment,
  SentimentSchema,
  type StockMetaDto,
  type StyleSignal,
  type ThemeClusterView,
  type WatchMarket,
} from '@quant/shared';
import { createHash } from 'node:crypto';

import { CLOCK, type Clock } from '../../common/clock.js';
import { LlmService } from '../llm/llm.service.js';
import { StockMetaService } from '../stock-meta/stock-meta.service.js';
import {
  collectStrings,
  parseClusterObject,
  parseCompetitive,
  parseIndustryTrendLine,
  parseInsightLine,
  parseJsonObject,
  parsePriceSignalLine,
  parseProductLine,
  parseResearchTargetLine,
  parseStyleSignalLine,
  parseThemeTagLine,
  clamp01,
} from './domain/pure/parsers.js';
import {
  buildSentimentClusterSystem,
  buildSentimentClusterUser,
  buildSentimentMarketSynthSystem,
  buildSentimentMarketSynthUser,
  buildSentimentSystem,
  buildSentimentUser,
  type SentimentMeta,
} from '@quant/config/prompts';
import { SentimentCacheStore } from './sentiment-cache.store.js';

const DEFAULT_WINDOW_DAYS = 30;

export interface SentimentCallContext {
  readonly userId: string;
  readonly traceId: string;
}

export interface AnalyzeOneArgs {
  readonly code: string;
  readonly windowDays?: number;
  readonly bypassCache?: boolean;
}

export interface AnalyzeManyArgs {
  readonly codes: readonly string[];
  readonly windowDays?: number;
  readonly bypassCache?: boolean;
}

/** Final-processor inference: throws on unknown shape so every consumer hits the same error message. */
function requireMarket(code: string): WatchMarket {
  const m = inferMarketFromCode(code);
  if (m === null) {
    throw new QuantError(
      'INVALID_ARGUMENT',
      `code ${code} matches no known market (a=6 digits, hk=4-5 digits, us=letters)`,
      { code },
    );
  }
  return m;
}

@Injectable()
export class NewsSentimentService {
  private readonly logger = new Logger(NewsSentimentService.name);

  constructor(
    @Inject(StockMetaService) private readonly meta: StockMetaService,
    @Inject(LlmService) private readonly llm: LlmService,
    @Inject(SentimentCacheStore) private readonly cache: SentimentCacheStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async getCachedStock(code: string, windowDays: number): Promise<Sentiment | null> {
    return this.cache.getStock(code, windowDays);
  }

  async getCachedMarket(
    codes: readonly string[],
    windowDays: number,
  ): Promise<MarketSentiment | null> {
    const canon = canonicaliseCodes(codes);
    if (canon.length === 0) return null;
    const codeHash = sha256(canon.join(','));
    return this.cache.getMarket(codeHash, windowDays);
  }

  async analyzeOne(args: AnalyzeOneArgs, ctx: SentimentCallContext): Promise<Sentiment> {
    const { code } = args;
    const market = requireMarket(code);
    const windowDays = args.windowDays ?? DEFAULT_WINDOW_DAYS;

    if (args.bypassCache !== true) {
      const cached = await this.cache.getStock(code, windowDays);
      if (cached !== null) return cached;
    }

    const asof = this.todayAsof();
    const meta = await this.resolveMeta(market, code, ctx.traceId);
    const result = await this.runPerStock({ market, meta, asof, windowDays, ctx });
    await this.cache.putStock(result, windowDays);
    return result;
  }

  async analyzeMany(args: AnalyzeManyArgs, ctx: SentimentCallContext): Promise<MarketSentiment> {
    if (args.codes.length === 0) {
      throw new QuantError('INVALID_ARGUMENT', 'codes must be non-empty', {});
    }
    const canon = canonicaliseCodes(args.codes);
    if (canon.length === 0) {
      throw new QuantError('INVALID_ARGUMENT', 'no valid codes after canonicalisation', {
        codes: args.codes,
      });
    }
    const market = requireMarket(canon[0] ?? '');
    if (!canon.every((c) => inferMarketFromCode(c) === market)) {
      throw new QuantError(
        'INVALID_ARGUMENT',
        'codes span multiple markets — aggregate analysis requires a single market',
        { codes: canon },
      );
    }
    const windowDays = args.windowDays ?? DEFAULT_WINDOW_DAYS;
    const codeHash = sha256(canon.join(','));

    if (args.bypassCache !== true) {
      const cached = await this.cache.getMarket(codeHash, windowDays);
      if (cached !== null) return cached;
    }
    const asof = this.todayAsof();

    const settled = await Promise.allSettled(
      canon.map((code) =>
        this.analyzeOne(
          {
            code,
            windowDays,
            ...(args.bypassCache === true ? { bypassCache: true } : {}),
          },
          ctx,
        ),
      ),
    );

    const perStock: Sentiment[] = [];
    const caveats: string[] = [];
    for (let i = 0; i < settled.length; i += 1) {
      const code = canon[i] ?? '';
      const r = settled[i];
      if (r === undefined) continue;
      if (r.status === 'rejected') {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        caveats.push(`${code}: ${msg}`);
        continue;
      }
      perStock.push(r.value);
    }
    if (perStock.length === 0) {
      throw new QuantError('LLM_FAILED', 'every per-stock analysis failed in analyzeMany', {
        codes: canon,
        caveats,
      });
    }

    const themeClusters = await this.runClusterStep(market, perStock, ctx);
    const synth = await this.runMarketSynthStep(market, perStock, themeClusters, ctx);

    const result: MarketSentiment = MarketSentimentSchema.parse({
      market,
      asof,
      windowDays,
      fetchedAt: this.clock.now().toISOString(),
      codeHash,
      codes: canon,
      brief: synth.brief,
      themeClusters,
      styleSignals: synth.styleSignals,
      industryTrends: synth.industryTrends,
      caveats: [...caveats, ...synth.caveats],
    });
    await this.cache.putMarket(result, windowDays);
    return result;
  }

  private async resolveMeta(
    market: WatchMarket,
    code: string,
    traceId: string,
  ): Promise<StockMetaDto> {
    if (market === 'a') return this.meta.get(code, traceId);
    // HK/US: no NestJS-side meta source yet — feed the prompt a stub and let
    // the LLM resolve name + industries via web_search (see prompt rule 11).
    return {
      code,
      name: '',
      industries: '',
    } as unknown as StockMetaDto;
  }

  // -------------------------------------------------------------------------
  // pipeline steps
  // -------------------------------------------------------------------------

  private async runPerStock(args: {
    readonly market: WatchMarket;
    readonly meta: StockMetaDto;
    readonly asof: string;
    readonly windowDays: number;
    readonly ctx: SentimentCallContext;
  }): Promise<Sentiment> {
    const promptMeta: SentimentMeta = {
      market: args.market,
      code: args.meta.code,
      name: args.meta.name,
      industries: industriesOf(args.meta),
    };
    const out = await this.llm.completeJsonWithWebSearch(
      {
        system: buildSentimentSystem(args.market),
        user: buildSentimentUser({
          meta: promptMeta,
          asof: args.asof,
          days: args.windowDays,
        }),
      },
      { userId: args.ctx.userId, traceId: args.ctx.traceId, scope: 'sentiment' },
    );
    return decodeStockSentiment({
      rawJson: out.text,
      market: args.market,
      code: args.meta.code,
      fetchedAt: this.clock.now().toISOString(),
    });
  }

  private async runClusterStep(
    market: WatchMarket,
    perStock: readonly Sentiment[],
    ctx: SentimentCallContext,
  ): Promise<readonly ThemeClusterView[]> {
    const memberships = perStock
      .filter((s) => s.hotThemes.length > 0)
      .map((s) => {
        const top = s.hotThemes[0];
        return {
          code: s.code,
          theme_label: top?.label ?? '',
          rationale: top?.rationale ?? '',
          relevance: top?.relevance ?? 0,
        };
      });
    if (memberships.length === 0) return [];

    const out = await this.llm.completeJson(
      {
        system: buildSentimentClusterSystem(market),
        user: buildSentimentClusterUser({ stocks: memberships }),
      },
      { userId: ctx.userId, traceId: ctx.traceId, scope: 'sentiment' },
    );
    const payload = parseJsonObject(out.text);
    if (payload === null) {
      this.logger.warn('sentiment_cluster_parse_failed err=invalid_json');
      return fallbackClusters(memberships);
    }
    const raw = payload['clusters'];
    if (!Array.isArray(raw)) return fallbackClusters(memberships);
    const decoded: ThemeClusterView[] = [];
    for (const entry of raw) {
      const c = parseClusterObject(entry);
      if (c !== null) decoded.push(c);
    }
    return decoded.length > 0 ? decoded : fallbackClusters(memberships);
  }

  private async runMarketSynthStep(
    market: WatchMarket,
    perStock: readonly Sentiment[],
    clusters: readonly ThemeClusterView[],
    ctx: SentimentCallContext,
  ): Promise<{
    readonly brief: string;
    readonly styleSignals: StyleSignal[];
    readonly industryTrends: IndustryTrend[];
    readonly caveats: string[];
  }> {
    const empty = { brief: '', styleSignals: [], industryTrends: [], caveats: [] };
    if (perStock.length === 0) return empty;
    const payload = {
      stocks: perStock.map((s) => ({
        code: s.code,
        // surface back in [-1,1] so the synth pass sees the raw model output
        sentiment_score: s.score * 2 - 1,
        top_theme: s.hotThemes[0]?.label ?? null,
        drivers: s.coreDrivers.slice(0, 3).map((d) => d.summary),
      })),
      clusters: clusters.map((c) => ({
        label: c.label,
        members: [...c.memberCodes],
        industries: [...c.relatedIndustries],
        trend: c.trend,
        summary: c.summary,
      })),
    };
    let out;
    try {
      out = await this.llm.completeJson(
        {
          system: buildSentimentMarketSynthSystem(market),
          user: buildSentimentMarketSynthUser(payload),
        },
        { userId: ctx.userId, traceId: ctx.traceId, scope: 'sentiment' },
      );
    } catch (err) {
      this.logger.warn(
        `sentiment_market_synth_failed err=${err instanceof Error ? err.message : String(err)}`,
      );
      return empty;
    }
    const decoded = parseJsonObject(out.text);
    if (decoded === null) return empty;
    const styleSignals: StyleSignal[] = [];
    for (const raw of collectStrings(decoded['styleSignals'])) {
      const s = parseStyleSignalLine(raw);
      if (s !== null) styleSignals.push(s);
    }
    const industryTrends: IndustryTrend[] = [];
    for (const raw of collectStrings(decoded['industryTrends'])) {
      const t = parseIndustryTrendLine(raw);
      if (t !== null) industryTrends.push(t);
    }
    return {
      brief: typeof decoded['brief'] === 'string' ? decoded['brief'] : '',
      styleSignals,
      industryTrends,
      caveats: collectStrings(decoded['caveats']),
    };
  }

  private todayAsof(): string {
    return this.clock.now().toISOString().slice(0, 10);
  }
}

// ---------------------------------------------------------------------------
// pure decoders (exported for testing)
// ---------------------------------------------------------------------------

export function decodeStockSentiment(args: {
  readonly rawJson: string;
  readonly market: WatchMarket;
  readonly code: string;
  readonly fetchedAt: string;
}): Sentiment {
  const obj = parseJsonObject(args.rawJson);
  if (obj === null) {
    const raw = args.rawJson;
    throw new QuantError('LLM_FAILED', 'sentiment output is not a JSON object', {
      market: args.market,
      code: args.code,
      length: raw.length,
      head: raw.slice(0, 200),
      tail: raw.length > 200 ? raw.slice(-200) : '',
    });
  }
  const rawScore = typeof obj['score'] === 'number' && Number.isFinite(obj['score']) ? obj['score'] : 0;
  // model emits [-1,1]; FE expects [0,1]
  const score = clamp01((rawScore + 1) / 2);
  const competitive = parseCompetitive(obj['competitive']);

  return SentimentSchema.parse({
    market: args.market,
    code: args.code,
    cachedAt: ensureOffsetIso(args.fetchedAt),
    brief: typeof obj['brief'] === 'string' ? obj['brief'] : '',
    score,
    coreDrivers: mapPipeArray(obj['drivers'], parseInsightLine),
    hotThemes: mapPipeArray(obj['themes'], parseThemeTagLine),
    coreProducts: mapPipeArray(obj['products'], parseProductLine),
    priceSignals: mapPipeArray(obj['signals'], parsePriceSignalLine),
    mAndA: mapPipeArray(obj['mna'], parseInsightLine),
    supplyDemand: mapPipeArray(obj['supply'], parseInsightLine),
    researchTargets: mapPipeArray(obj['research'], parseResearchTargetLine),
    competitiveLandscape: competitive,
    coverageGaps: collectStrings(obj['gaps']),
    caveats: collectStrings(obj['caveats']),
  });
}

function mapPipeArray<T>(raw: unknown, parse: (line: unknown) => T | null): T[] {
  if (!Array.isArray(raw)) return [];
  const out: T[] = [];
  for (const v of raw) {
    const parsed = parse(v);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

function fallbackClusters(
  memberships: readonly { code: string; theme_label: string }[],
): readonly ThemeClusterView[] {
  const byLabel = new Map<string, string[]>();
  for (const m of memberships) {
    const list = byLabel.get(m.theme_label) ?? [];
    list.push(m.code);
    byLabel.set(m.theme_label, list);
  }
  return [...byLabel.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([label, codes]) => ({
      label,
      memberCodes: [...codes],
      relatedIndustries: [],
      heatScore: 0,
      trend: 'stable' as const,
      summary: '',
    }));
}

function ensureOffsetIso(s: string): string {
  if (s.length === 0) return new Date().toISOString();
  if (/[zZ]|[+-]\d{2}:?\d{2}$/u.test(s)) return s;
  return `${s}Z`;
}

/**
 * Dedup + sort. Codes that match no market are dropped silently — the
 * downstream `analyzeMany` then asserts the surviving codes all share
 * a single market, throwing a clear error if they don't.
 */
function canonicaliseCodes(codes: readonly string[]): readonly string[] {
  const set = new Set<string>();
  for (const c of codes) {
    if (typeof c !== 'string') continue;
    if (inferMarketFromCode(c) === null) continue;
    set.add(c);
  }
  return [...set].sort();
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function industriesOf(meta: StockMetaDto): string {
  const v = (meta as unknown as { industries?: unknown }).industries;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.filter((s): s is string => typeof s === 'string').join(',');
  return '';
}
