/**
 * Pure projectors that adapt the @quant/shared DTOs returned by the
 * NestJS gateway into the simplified shapes that the @quant/terminal
 * action registry validates against.
 *
 * Kept in `lib/` (CLAUDE.md §2.5.1 — pure, no IO) so the converters
 * can be unit-tested without spinning up fetch.
 */

import type {
  KlineBar as SharedKlineBar,
  MarketSentiment as SharedMarketSentiment,
  NlScreenResult,
  Sentiment as SharedSentiment,
  StockMetaDto,
  StockSnapshotDto,
  WatchTask as SharedWatchTask,
} from '@quant/shared';
import type {
  KlineBar as TermKlineBar,
  MarketSentiment as TermMarketSentiment,
  ScreenResult,
  Sentiment as TermSentiment,
  StockMeta as TermStockMeta,
  StockSnapshot as TermStockSnapshot,
  WatchTask as TermWatchTask,
} from '@quant/terminal';

/* ---------- meta ---------- */

export function metaToTerm(m: StockMetaDto): TermStockMeta {
  return {
    code: m.code,
    name: m.name,
    pinyin: m.name_pinyin,
    // Terminal `industry` is nullable / optional — pass empty as null so
    // downstream renderers display the canonical "—" placeholder.
    industry: m.industries.length === 0 ? null : m.industries,
    // Shared meta is universe = A. HK / US live in `/api/watch/universe`
    // (returned as StockBasic, not StockMetaDto), and the terminal's
    // stock.* actions only operate on A — keep the projector in sync.
    market: 'a',
  };
}

/* ---------- kline ---------- */

export function klineToTerm(b: SharedKlineBar): TermKlineBar {
  return {
    date: b.date,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: b.volume,
  };
}

/* ---------- snapshot ---------- */

export function snapshotToTerm(s: StockSnapshotDto): TermStockSnapshot {
  return {
    code: s.meta.code,
    price: toFiniteNum(s.price),
    asof: s.asof,
    pe_ttm: toFiniteNum(s.derived.pe_ttm),
    pb: toFiniteNum(s.derived.pb),
    mkt_cap: toFiniteNum(s.derived.mkt_cap),
  };
}

/* ---------- sentiment ---------- */

export function sentimentToTerm(s: SharedSentiment): TermSentiment {
  return {
    code: s.code,
    // Shared sentiment scores are in [-1, 1]; terminal schema is the
    // same range — no rescale needed.
    score: clamp(s.score, -1, 1),
    theme: s.theme,
    driver: s.driver.length === 0 ? null : s.driver,
    cachedAt: s.cachedAt,
  };
}

export function marketSentimentToTerm(
  s: SharedMarketSentiment,
  /** original codes — terminal schema includes them, shared aggregates by cluster */
  codes: readonly string[],
): TermMarketSentiment {
  // Shared MarketSentiment has no single "boardScore" — we average the
  // cluster heat scores as a stand-in so the terminal can show a single
  // number. Cluster heat already lives in [-1, 1] per the Python pipeline.
  const heats = s.themeClusters.map((c) => c.heatScore).filter((n) => Number.isFinite(n));
  const avg = heats.length === 0 ? 0 : heats.reduce((a, b) => a + b, 0) / heats.length;
  return {
    codes: [...codes],
    score: clamp(avg, -1, 1),
    themes: s.themeClusters.map((t) => t.label),
    cachedAt: s.fetchedAt,
  };
}

/* ---------- screen ---------- */

/**
 * Project the rich `NlScreenResult` into the terminal's `ScreenResult`.
 *
 * Shared `NlScreenResult.matches` is `{ code, evidence }` — no name, no
 * single score. The terminal display needs `{ code, name, score? }`.
 * Names come from the caller-supplied lookup (the bridge feeds in the
 * stock-universe map). Score is best-effort: we pull a numeric
 * `evidence.score` if the evaluator emitted one, else `null`.
 */
export function screenToTerm(
  r: NlScreenResult,
  lookupName: (code: string) => string | null,
): ScreenResult {
  return {
    nl: r.nl,
    matches: r.matches.map((m) => {
      const evScore = (m.evidence as Record<string, unknown>)['score'];
      return {
        code: m.code,
        name: lookupName(m.code) ?? m.code,
        score: typeof evScore === 'number' ? evScore : null,
      };
    }),
    // Shared has `screenPlan` (AST) — render a one-line summary.
    dslSummary: `${String(r.matches.length)} matches`,
  };
}

/* ---------- watch ---------- */

/**
 * Project a shared `WatchTask` (rich, includes timing fields) into the
 * subset the terminal action schema validates against. Both sides use
 * the same `conditions[]` shape so the field can be passed through; we
 * only pick the columns the terminal cares about.
 */
export function watchToTerm(t: SharedWatchTask): TermWatchTask {
  return {
    market: t.market,
    code: t.code,
    name: t.name,
    conditions: t.conditions,
    intervalSec: t.intervalSec,
    pushIntervalSec: t.pushIntervalSec,
    enabled: t.enabled,
    hitCount: t.hitCount,
  };
}

/**
 * Build a `WatchTaskCreate` body suitable for `POST /api/watch` from a
 * terminal-shaped task. Adds the gateway-required `notifySlack` /
 * `remaining` fields with sensible defaults.
 */
export function watchToCreate(t: TermWatchTask): {
  readonly market: TermWatchTask['market'];
  readonly code: string;
  readonly name: string;
  readonly conditions: TermWatchTask['conditions'];
  readonly intervalSec: number;
  readonly pushIntervalSec: number;
  readonly remaining: null;
  readonly notifySlack: boolean;
  readonly enabled: boolean;
} {
  return {
    market: t.market,
    code: t.code,
    name: t.name,
    conditions: t.conditions,
    intervalSec: Math.max(5, t.intervalSec),
    pushIntervalSec: Math.max(60, t.pushIntervalSec),
    remaining: null,
    notifySlack: true,
    enabled: t.enabled,
  };
}

/* ---------- helpers ---------- */

function toFiniteNum(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(lo, Math.min(hi, v));
}
