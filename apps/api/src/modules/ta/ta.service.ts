/**
 * Technical-analysis pipeline (NestJS-side).
 *
 *   1. lookup `StockMeta` (`STOCK_NOT_FOUND` if missing)
 *   2. fetch last ≤ 90 daily bars via Flight `list_kline_for_code`
 *      (`KLINE_DATA_MISSING` if empty)
 *   3. resolve `asof` = last bar's date (cache key follows the data,
 *      not the wall clock)
 *   4. cache lookup unless `bypassCache=true` — hit returns immediately
 *   5. build prompt + call `LlmService.completeJson(scope='ta')`
 *   6. decode JSON → `TaAnalysis`, write through cache, return
 *
 * Replaces the Python `quant_core.services.ta_service.TaService`. The
 * Python `analyze_ta_one` / `get_cached_ta_one` Flight ops are gone —
 * NestJS serves `/api/ta/analyze_one` (cached + paid) entirely locally.
 * The kline read still lives in Python (parquet store).
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  QuantError,
  TaSectorAnalysisSchema,
  type KlineBar,
  type StockMetaDto,
  type TaAnalysis,
  type TaSectorAnalysis,
  type TaSectorMember,
} from '@quant/shared';

import { CLOCK, type Clock } from '../../common/clock.js';
import { KlineReaderService } from '../kline/kline-reader.service.js';
import { LlmService } from '../llm/llm.service.js';
import { StockMetaService } from '../stock-meta/stock-meta.service.js';
import { decodeTaAnalysis } from './domain/decode-ta.js';
import { buildSectorSummaryPrompt } from './prompts/sector-summary.prompt.js';
import { buildTaSystemPrompt, buildTaUserPrompt } from './prompts/ta-analyze.prompt.js';
import { TaCacheStore } from './ta-cache.store.js';

const BARS_WINDOW = 90;

export interface TaCallContext {
  readonly userId: string;
  readonly traceId: string;
}

@Injectable()
export class TaService {
  constructor(
    @Inject(KlineReaderService) private readonly klineReader: KlineReaderService,
    @Inject(StockMetaService) private readonly meta: StockMetaService,
    @Inject(LlmService) private readonly llm: LlmService,
    @Inject(TaCacheStore) private readonly cache: TaCacheStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Cache-only read (mirrors the deleted `get_cached_ta_one` Flight op). */
  async getCached(code: string, traceId: string): Promise<TaAnalysis | null> {
    const bars = await this.fetchBars(code, traceId);
    if (bars.length === 0) return null;
    const asof = bars[bars.length - 1]?.date ?? '';
    return this.cache.get(code, asof);
  }

  /**
   * Fresh analysis. Calls LlmService unless a cached row matches the
   * resolved `asof`; emits a `data/users/{userId}/llm-ledger.json` row
   * via `LlmService` regardless.
   */
  async analyzeOne(code: string, bypassCache: boolean, ctx: TaCallContext): Promise<TaAnalysis> {
    const meta = await this.meta.get(code, ctx.traceId);
    const bars = await this.fetchBars(code, ctx.traceId);
    if (bars.length === 0) {
      throw new QuantError('KLINE_DATA_MISSING', `no kline bars for code ${code}`, { code });
    }
    const asof = bars[bars.length - 1]?.date ?? '';

    if (!bypassCache) {
      const cached = await this.cache.get(code, asof);
      if (cached !== null) return cached;
    }

    const out = await this.llm.completeJson(
      {
        system: buildTaSystemPrompt(),
        user: buildTaUserPrompt({
          code,
          name: meta.name,
          industries: industriesOf(meta),
          asof,
          bars,
        }),
      },
      { userId: ctx.userId, traceId: ctx.traceId, scope: 'ta' },
    );
    const result = decodeTaAnalysis({
      raw: out.text,
      code,
      asof,
      barsCount: bars.length,
      fetchedAt: this.clock.now().toISOString(),
      provider: out.provider,
    });
    await this.cache.put(result);
    return result;
  }

  private async fetchBars(code: string, _traceId: string): Promise<readonly KlineBar[]> {
    void _traceId;
    return this.klineReader.lastNForCode(code, BARS_WINDOW);
  }

  /**
   * Sector-level TA: per-stock fan-out + LLM-synthesised narrative.
   *
   * Pulled out of {@link TaController.analyzeMany} so the IM
   * `/ta.sector` handler can reuse it. Per-stock calls hit the local
   * TA cache first (so a re-run of a sector with warm members is mostly
   * cache reads). Concurrency is bounded by the caller's `codes` length;
   * the IM handler caps it at the `codes.length ≤ 50` invariant the
   * existing HTTP route enforces.
   */
  async analyzeSector(args: {
    readonly codes: readonly string[];
    readonly label: string;
    readonly bypassCache?: boolean;
    readonly ctx: TaCallContext;
  }): Promise<TaSectorAnalysis> {
    if (args.codes.length === 0) {
      throw new QuantError('INVALID_ARGUMENT', 'codes must be non-empty', {});
    }
    const codes = [...args.codes];
    const settled = await Promise.allSettled(
      codes.map((code) => this.analyzeOne(code, args.bypassCache === true, args.ctx)),
    );
    const members: TaSectorMember[] = [];
    const caveats: string[] = [];
    let up = 0;
    let down = 0;
    let sideways = 0;
    for (let i = 0; i < settled.length; i += 1) {
      const code = codes[i] ?? '';
      const r = settled[i];
      if (r === undefined) continue;
      if (r.status === 'rejected') {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        caveats.push(`${code}: ${msg}`);
        continue;
      }
      const ta = r.value;
      if (ta.trend.direction === 'up') up += 1;
      else if (ta.trend.direction === 'down') down += 1;
      else sideways += 1;
      members.push({
        code: ta.code,
        name: '',
        asof: ta.asof,
        trend: ta.trend,
        keyResistance: ta.resistanceLevels[0]?.price ?? null,
        keySupport: ta.supportLevels[0]?.price ?? null,
        headline: ta.trend.rationale,
      });
    }
    if (members.length === 0) {
      throw new QuantError('EVALUATION_FAILED', 'no member TA could be produced', {
        codes,
        caveats,
      });
    }
    const overallDirection = pickOverallDirection({ up, down, sideways });
    const overallConfidence = avgConfidence(members, overallDirection);
    const summary = await this.summariseSector({
      label: args.label,
      members,
      trendBreakdown: { up, down, sideways },
      overallDirection,
      overallConfidence,
      ctx: args.ctx,
    });
    return TaSectorAnalysisSchema.parse({
      codes,
      trendBreakdown: { up, down, sideways },
      overallDirection,
      overallConfidence,
      members,
      summary,
      caveats,
      cachedAt: this.clock.now().toISOString(),
    });
  }

  private async summariseSector(input: {
    readonly label: string;
    readonly members: readonly TaSectorMember[];
    readonly trendBreakdown: {
      readonly up: number;
      readonly down: number;
      readonly sideways: number;
    };
    readonly overallDirection: 'up' | 'down' | 'sideways';
    readonly overallConfidence: number;
    readonly ctx: TaCallContext;
  }): Promise<string> {
    const prompt = buildSectorSummaryPrompt({
      sectorLabel: input.label,
      members: input.members,
      trendBreakdown: input.trendBreakdown,
      overallDirection: input.overallDirection,
      overallConfidence: input.overallConfidence,
    });
    try {
      const out = await this.llm.completeJson(
        { system: prompt.system, user: prompt.user },
        { userId: input.ctx.userId, traceId: input.ctx.traceId, scope: 'ta' },
      );
      return out.text.trim();
    } catch {
      // Sector view degrades gracefully — caller still gets the
      // numerical aggregate; we just surface a non-blocking caveat.
      return '';
    }
  }
}

function pickOverallDirection(b: {
  readonly up: number;
  readonly down: number;
  readonly sideways: number;
}): 'up' | 'down' | 'sideways' {
  if (b.up >= b.down && b.up >= b.sideways) return 'up';
  if (b.down >= b.up && b.down >= b.sideways) return 'down';
  return 'sideways';
}

function avgConfidence(
  members: readonly TaSectorMember[],
  direction: 'up' | 'down' | 'sideways',
): number {
  let sum = 0;
  let count = 0;
  for (const m of members) {
    if (m.trend.direction !== direction) continue;
    sum += m.trend.confidence;
    count += 1;
  }
  return count === 0 ? 0 : sum / count;
}

function industriesOf(meta: StockMetaDto): string {
  // `StockMetaDto.industries` is typed `string` (comma-joined coarse→fine,
  // e.g. "食品饮料,白酒"). Empty string is allowed. The prompt builder
  // only needs the raw value — pass it through.
  return meta.industries;
}

// Arrow → KlineBar conversion is delegated to the kline module's mapper
// (`apps/api/src/modules/kline/domain/arrow-mapper.ts`). The previous
// in-file copy used a homebrew `toNumber` that ignored the Decimal128
// scale: price columns are persisted as `decimal128(20, 4)`, so a BigInt
// of unscaled units (e.g. 12345600 for 1234.5600) was returned verbatim
// — every price (and therefore every TA support / resistance level the
// LLM produced from those bars) came back ×10^4. The shared mapper
// reads `field.type.scale` and divides accordingly.
