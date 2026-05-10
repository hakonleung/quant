/**
 * NestJS-side news-sentiment pipeline. Replaces the 936-line Python
 * `quant_core.services.news_sentiment_service.NewsSentimentService`.
 *
 * Per-stock pipeline (`analyzeOne`):
 *   1. meta lookup (`STOCK_NOT_FOUND` if missing)
 *   2. cache hit by (code, asof, windowDays) → return immediately
 *   3. step-1: `LlmService.completeWithWebSearch` (analyst pass, free
 *      text, scope='sentiment'). Verbatim text → `Sentiment.result`.
 *   4. step-2: `LlmService.completeJson` (flash, no web search) on the
 *      research text → rich JSON. Project to slim `Sentiment` view
 *      (the FE only ever consumes the slim shape).
 *   5. write through cache.
 *
 * Multi-stock (`analyzeMany`):
 *   1. fan out per-stock (Promise.all, bounded by codes cap = 200)
 *   2. theme cluster pass (`LlmService.completeJson`, no web search)
 *   3. market synth pass (`LlmService.completeJson`, no web search)
 *   4. project both passes into the slim `MarketSentiment` view.
 *   5. write through market cache.
 *
 * Failures on individual codes during `analyzeMany` collapse to caveats;
 * the call as a whole succeeds as long as ≥ 1 stock returned a payload.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  MarketSentimentSchema,
  QuantError,
  SentimentSchema,
  type MarketSentiment,
  type Sentiment,
  type StockMetaDto,
  type ThemeClusterView,
} from '@quant/shared';
import { createHash } from 'node:crypto';

import { CLOCK, type Clock } from '../../common/clock.js';
import { LlmService } from '../llm/llm.service.js';
import { StockMetaService } from '../stock-meta/stock-meta.service.js';
import {
  buildSentimentClusterSystem,
  buildSentimentClusterUser,
  buildSentimentMarketSynthSystem,
  buildSentimentMarketSynthUser,
  buildSentimentSearchSystem,
  buildSentimentSearchUser,
  buildSentimentSummarizeSystem,
  buildSentimentSummarizeUser,
  type SentimentMeta,
} from './prompts/sentiment.prompt.js';
import { SentimentCacheStore } from './sentiment-cache.store.js';

const DEFAULT_WINDOW_DAYS = 30;
const FENCE_RE = /^```(?:json)?\s*([\s\S]+?)```$/u;

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
    const codeHash = sha256(canon.join(','));
    return this.cache.getMarket(codeHash, windowDays);
  }

  async analyzeOne(args: AnalyzeOneArgs, ctx: SentimentCallContext): Promise<Sentiment> {
    const code = args.code;
    const windowDays = args.windowDays ?? DEFAULT_WINDOW_DAYS;

    if (args.bypassCache !== true) {
      const cached = await this.cache.getStock(code, windowDays);
      if (cached !== null) return cached;
    }

    // `asof` is still today's UTC date — it goes into the LLM prompt as
    // "截止日期" so the analyst pass anchors on a stable timestamp. It's
    // no longer used as a cache key (TTL is now timestamp-driven).
    const asof = this.todayAsof();
    const meta = await this.meta.get(code, ctx.traceId);
    const result = await this.runPerStock({ meta, asof, windowDays, ctx });
    await this.cache.putStock(result, windowDays);
    return result;
  }

  async analyzeMany(args: AnalyzeManyArgs, ctx: SentimentCallContext): Promise<MarketSentiment> {
    if (args.codes.length === 0) {
      throw new QuantError('INVALID_ARGUMENT', 'codes must be non-empty', {});
    }
    const windowDays = args.windowDays ?? DEFAULT_WINDOW_DAYS;
    const canon = canonicaliseCodes(args.codes);
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

    const themeClusters = await this.runClusterStep(perStock, ctx);
    const marketTrendSummary = await this.runMarketSynthStep(perStock, themeClusters, ctx);

    const result: MarketSentiment = MarketSentimentSchema.parse({
      asof,
      windowDays,
      fetchedAt: this.clock.now().toISOString(),
      codeHash,
      codes: canon,
      themeClusters,
      marketTrendSummary,
      caveats,
    });
    await this.cache.putMarket(result, windowDays);
    return result;
  }

  // -------------------------------------------------------------------------
  // pipeline steps
  // -------------------------------------------------------------------------

  private async runPerStock(args: {
    readonly meta: StockMetaDto;
    readonly asof: string;
    readonly windowDays: number;
    readonly ctx: SentimentCallContext;
  }): Promise<Sentiment> {
    const promptMeta: SentimentMeta = {
      code: args.meta.code,
      name: args.meta.name,
      industries: industriesOf(args.meta),
    };
    const llmCtx = {
      userId: args.ctx.userId,
      traceId: args.ctx.traceId,
      scope: 'sentiment' as const,
    };

    // Step 1: web-search analyst pass — verbatim free text.
    const search = await this.llm.completeWithWebSearch(
      {
        system: buildSentimentSearchSystem(),
        user: buildSentimentSearchUser({
          meta: promptMeta,
          asof: args.asof,
          days: args.windowDays,
        }),
      },
      llmCtx,
    );
    const researchText = search.text;

    // Step 2: flash JSON extraction; up to one retry (mirrors Python).
    let userPrompt = buildSentimentSummarizeUser({
      meta: promptMeta,
      asof: args.asof,
      days: args.windowDays,
      researchText,
    });
    let lastErr: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const out = await this.llm.completeJson(
        { system: buildSentimentSummarizeSystem(), user: userPrompt },
        llmCtx,
      );
      try {
        return projectStockSentiment({
          rawJson: out.text,
          code: args.meta.code,
          researchText,
          fetchedAt: this.clock.now().toISOString(),
        });
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `sentiment_summarize_parse_failed attempt=${String(attempt)} code=${args.meta.code} err=${lastErr}`,
        );
        userPrompt =
          `${userPrompt}\n\nYour previous JSON failed validation: ${lastErr}\n` +
          'Emit a corrected JSON only. Do not repeat the same mistake.';
      }
    }
    throw new QuantError(
      'LLM_FAILED',
      `could not summarise research text for ${args.meta.code}: ${lastErr ?? '(no error)'}`,
      { code: args.meta.code, last_error: lastErr ?? '' },
    );
  }

  private async runClusterStep(
    perStock: readonly Sentiment[],
    ctx: SentimentCallContext,
  ): Promise<readonly ThemeClusterView[]> {
    // Build the cluster input from the per-stock view's `theme` field.
    const memberships = perStock
      .filter((s) => s.theme.length > 0)
      .map((s) => ({ code: s.code, theme_label: s.theme, rationale: s.driver, relevance: 1 }));
    if (memberships.length === 0) return [];

    const out = await this.llm.completeJson(
      {
        system: buildSentimentClusterSystem(),
        user: buildSentimentClusterUser({ stocks: memberships }),
      },
      { userId: ctx.userId, traceId: ctx.traceId, scope: 'sentiment' },
    );
    try {
      const payload = parseJsonObject(out.text);
      return projectClusters(payload['clusters']);
    } catch (err) {
      this.logger.warn(
        `sentiment_cluster_parse_failed err=${err instanceof Error ? err.message : String(err)}`,
      );
      return fallbackClusters(memberships);
    }
  }

  private async runMarketSynthStep(
    perStock: readonly Sentiment[],
    clusters: readonly ThemeClusterView[],
    ctx: SentimentCallContext,
  ): Promise<string> {
    if (perStock.length === 0) return '';
    const payload = {
      stocks: perStock.map((s) => ({
        code: s.code,
        sentiment_score: s.score * 2 - 1,
        top_theme: s.theme.length > 0 ? s.theme : null,
        core_drivers: s.driver.length > 0 ? [s.driver] : [],
      })),
      clusters: clusters.map((c) => ({
        label: c.label,
        members: [],
        industries: [],
        trend: 'stable',
        summary: c.summary,
      })),
    };
    try {
      const out = await this.llm.completeJson(
        {
          system: buildSentimentMarketSynthSystem(),
          user: buildSentimentMarketSynthUser(payload),
        },
        { userId: ctx.userId, traceId: ctx.traceId, scope: 'sentiment' },
      );
      const decoded = parseJsonObject(out.text);
      const trend = decoded['market_trend'];
      if (typeof trend === 'object' && trend !== null) {
        const summary = (trend as Record<string, unknown>)['summary'];
        if (typeof summary === 'string') return summary;
      }
      return '';
    } catch (err) {
      this.logger.warn(
        `sentiment_market_synth_failed err=${err instanceof Error ? err.message : String(err)}`,
      );
      return '';
    }
  }

  private todayAsof(): string {
    return this.clock.now().toISOString().slice(0, 10);
  }
}

// ---------------------------------------------------------------------------
// pure projectors / decoders
// ---------------------------------------------------------------------------

function projectStockSentiment(args: {
  readonly rawJson: string;
  readonly code: string;
  readonly researchText: string;
  readonly fetchedAt: string;
}): Sentiment {
  const payload = parseJsonObject(args.rawJson);
  const sentimentScore = readNumber(payload['sentiment_score']);
  if (sentimentScore === null) {
    throw new QuantError('LLM_FAILED', "missing or invalid 'sentiment_score'", {});
  }
  // Python service stores the [-1,1] score; the FE view expects [0,1].
  const score = clamp01((sentimentScore + 1) / 2);

  const themes = readArray(payload['hot_themes']);
  const topTheme =
    themes.length > 0 && isObj(themes[0]) ? readString((themes[0] as RawObj)['label']) : '';

  const drivers = readArray(payload['core_drivers']);
  const topDriver =
    drivers.length > 0 && isObj(drivers[0]) ? readString((drivers[0] as RawObj)['summary']) : '';

  const research = readArray(payload['research_targets']);
  const targetUpside =
    research.length > 0 && isObj(research[0])
      ? (readNumber((research[0] as RawObj)['target_upside_pct']) ?? 0)
      : 0;

  const rumor = pickFirstRumor([[...drivers], [...readArray(payload['m_and_a'])]]);
  const rawLog = synthesiseRawLog({ score, topTheme, topDriver, targetUpside }, payload);

  return SentimentSchema.parse({
    code: args.code,
    score,
    theme: topTheme,
    driver: topDriver,
    target: targetUpside,
    rumor,
    cachedAt: ensureOffsetIso(args.fetchedAt),
    rawLog,
    result: args.researchText,
  });
}

function projectClusters(raw: unknown): readonly ThemeClusterView[] {
  if (!Array.isArray(raw)) return [];
  const out: ThemeClusterView[] = [];
  for (const entry of raw) {
    if (!isObj(entry)) continue;
    const label = readString(entry['theme_label']);
    if (label.length === 0) continue;
    const members = readArray(entry['member_codes']);
    const heat = readNumber(entry['heat_score']) ?? 0;
    const summary = readString(entry['summary']);
    out.push({ label, memberCount: members.length, heatScore: heat, summary });
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
      memberCount: codes.length,
      heatScore: 0,
      summary: '',
    }));
}

// ---------------------------------------------------------------------------
// raw-log + helpers
// ---------------------------------------------------------------------------

type RawObj = Readonly<Record<string, unknown>>;

function synthesiseRawLog(
  view: { score: number; topTheme: string; topDriver: string; targetUpside: number },
  raw: RawObj,
): readonly string[] {
  const lines: string[] = [];
  lines.push(`▎ source  llm.web_search · ${String(readArray(raw['core_drivers']).length)} drivers`);
  if (view.topTheme.length > 0) lines.push(`▎ theme   ${view.topTheme}`);
  if (view.topDriver.length > 0) lines.push(`▎ driver  ${view.topDriver}`);
  if (view.targetUpside !== 0) lines.push(`▎ target  ${view.targetUpside.toFixed(2)}%`);
  lines.push(`▎ score   ${view.score.toFixed(2)} / 1.0`);
  for (const c of readArray(raw['caveats'])) {
    const s = readString(c);
    if (s.length > 0) lines.push(`! ${s}`);
  }
  return lines;
}

function pickFirstRumor(buckets: readonly (readonly unknown[])[]): string {
  for (const list of buckets) {
    for (const item of list) {
      if (isObj(item) && item['is_rumor'] === true) return readString(item['summary']);
    }
  }
  return '';
}

function parseJsonObject(raw: string): RawObj {
  const trimmed = raw.trim();
  const fenced = FENCE_RE.exec(trimmed);
  const stripped = fenced !== null ? (fenced[1]?.trim() ?? trimmed) : trimmed;
  let payload: unknown;
  try {
    payload = JSON.parse(stripped);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new QuantError('LLM_FAILED', `output is not valid JSON: ${msg}`, {
      snippet: raw.slice(0, 200),
    });
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new QuantError('LLM_FAILED', 'output is not a JSON object', {});
  }
  return payload as RawObj;
}

function isObj(v: unknown): v is RawObj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readArray(v: unknown): readonly unknown[] {
  return Array.isArray(v) ? v : [];
}

function readString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function readNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function ensureOffsetIso(s: string): string {
  if (s.length === 0) return new Date().toISOString();
  if (/[zZ]|[+-]\d{2}:?\d{2}$/u.test(s)) return s;
  return `${s}Z`;
}

function canonicaliseCodes(codes: readonly string[]): readonly string[] {
  const set = new Set<string>();
  for (const c of codes) {
    if (typeof c === 'string' && /^\d{6}$/u.test(c)) set.add(c);
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
