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
  KlineBarSchema,
  QuantError,
  type KlineBar,
  type StockMetaDto,
  type TaAnalysis,
} from '@quant/shared';
import type { Table } from 'apache-arrow';

import { FlightClient } from '../../adapters/flight/flight-client.js';
import { CLOCK, type Clock } from '../../common/clock.js';
import { LlmService } from '../llm/llm.service.js';
import { StockMetaService } from '../stock-meta/stock-meta.service.js';
import { decodeTaAnalysis } from './domain/decode-ta.js';
import { buildTaSystemPrompt, buildTaUserPrompt } from './prompts/ta-analyze.prompt.js';
import { TaCacheStore } from './ta-cache.store.js';
import { TA_FLIGHT_CLIENT } from './ta.token.js';

const BARS_WINDOW = 90;

export interface TaCallContext {
  readonly userId: string;
  readonly traceId: string;
}

@Injectable()
export class TaService {
  constructor(
    @Inject(TA_FLIGHT_CLIENT) private readonly flight: FlightClient,
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
  async analyzeOne(
    code: string,
    bypassCache: boolean,
    ctx: TaCallContext,
  ): Promise<TaAnalysis> {
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

  private async fetchBars(code: string, traceId: string): Promise<readonly KlineBar[]> {
    const result = await this.flight.doGet(
      'list_kline_for_code',
      { code, n: BARS_WINDOW },
      { traceId },
    );
    return arrowTableToKlineBars(result.value);
  }
}

function industriesOf(meta: StockMetaDto): string {
  // StockMetaDto's `industries` may be array, comma-string, or absent —
  // the prompt needs a single comma-joined string. Be defensive.
  const v = (meta as unknown as { industries?: unknown }).industries;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.filter((s): s is string => typeof s === 'string').join(',');
  return '';
}

// ---------------------------------------------------------------------------
// arrow → KlineBar (local copy; the kline module's mapper is private to
// that module and we don't want to bleed kline internals through DI just
// to read 90 rows here).
// ---------------------------------------------------------------------------

interface RowAccess {
  readonly trade_date: unknown;
  readonly volume: unknown;
  readonly amount: unknown;
  readonly turnover_rate: unknown;
  readonly open_qfq: unknown;
  readonly high_qfq: unknown;
  readonly low_qfq: unknown;
  readonly close_qfq: unknown;
  readonly ma5: unknown;
  readonly ma10: unknown;
  readonly ma20: unknown;
  readonly ma60: unknown;
}

function arrowTableToKlineBars(table: Table): readonly KlineBar[] {
  const out: KlineBar[] = [];
  for (let i = 0; i < table.numRows; i++) {
    const proxy = table.get(i);
    if (proxy === null) continue;
    const row = proxy.toJSON() as RowAccess;
    const bar = {
      date: typeof row.trade_date === 'string' ? row.trade_date.slice(0, 10) : '',
      open: toNumber(row.open_qfq),
      high: toNumber(row.high_qfq),
      low: toNumber(row.low_qfq),
      close: toNumber(row.close_qfq),
      volume: toNumber(row.volume),
      turnover: toNumber(row.amount),
      turnoverRate: toNumber(row.turnover_rate),
      ma5: toNullable(row.ma5),
      ma10: toNullable(row.ma10),
      ma20: toNullable(row.ma20),
      ma60: toNullable(row.ma60),
    };
    const parsed = KlineBarSchema.safeParse(bar);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

function toNumber(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  if (typeof v === 'bigint') return Number(v);
  if (v !== null && typeof v === 'object' && 'toString' in v) {
    const n = Number((v as { toString(): string }).toString());
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function toNullable(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = toNumber(v);
  return Number.isFinite(n) ? n : null;
}
