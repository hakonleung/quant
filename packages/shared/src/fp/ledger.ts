/**
 * Pure functions for ledger entries (CLAUDE.md §2.5.1: no IO, no globals,
 * deterministic). All decimal math goes through `decimal.js` so we never
 * lose precision on cumulative sums / compounded ratios.
 *
 * The flow most callers will use:
 *
 *   1. `mergeEntries(existing, incoming)` — apply imports / upserts
 *   2. `validateLedger(merged)`           — reject if anchor / dup-date broken
 *   3. `enrichEntries(merged)`            — fill chain-derived fields
 *   4. summary helpers (totalPnlAmount / totalReturnPct / currentPosition / …)
 *
 * The validate / enrich split exists so the API layer can produce
 * targeted error responses (the controller validates with a specific
 * `ErrorCode` and only enriches once it knows the snapshot is well-formed).
 */

import { Decimal } from 'decimal.js';

import type { ErrorCode } from '../contracts/errors.js';
import type { EnrichedLedgerEntry, LedgerEntry } from '../types/ledger.js';

/* ---------- ordering & merge ---------- */

export function sortEntries(entries: readonly LedgerEntry[]): readonly LedgerEntry[] {
  return [...entries].sort((a, b) => a.date.localeCompare(b.date));
}

export function dedupeByDate(entries: readonly LedgerEntry[]): readonly LedgerEntry[] {
  const byDate = new Map<string, LedgerEntry>();
  for (const e of entries) byDate.set(e.date, e);
  return sortEntries(Array.from(byDate.values()));
}

/**
 * Import / upsert merge: `incoming` overwrites `existing` on date
 * collisions. Result is sorted asc by date with no duplicates.
 */
export function mergeEntries(
  existing: readonly LedgerEntry[],
  incoming: readonly LedgerEntry[],
): readonly LedgerEntry[] {
  const byDate = new Map<string, LedgerEntry>();
  for (const e of existing) byDate.set(e.date, e);
  for (const e of incoming) byDate.set(e.date, e);
  return sortEntries(Array.from(byDate.values()));
}

/* ---------- validation ---------- */

export type LedgerValidationError =
  | { readonly code: 'LEDGER_FIRST_NEEDS_CLOSING_POSITION'; readonly message: string }
  | {
      readonly code: 'LEDGER_DUPLICATE_DATE';
      readonly message: string;
      readonly date: string;
    };

export type LedgerValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: LedgerValidationError };

/**
 * Structural invariants the persisted snapshot must satisfy:
 *
 *   1. No duplicate dates.
 *   2. The earliest entry (after sort) carries a non-null
 *      `closingPosition` — anchors the derived chain.
 *
 * Empty snapshot is valid (allows the user to start fresh).
 */
export function validateLedger(entries: readonly LedgerEntry[]): LedgerValidationResult {
  if (entries.length === 0) return { ok: true };

  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.date)) {
      return {
        ok: false,
        error: {
          code: 'LEDGER_DUPLICATE_DATE',
          message: `duplicate ledger entry for ${e.date}`,
          date: e.date,
        },
      };
    }
    seen.add(e.date);
  }

  const sorted = sortEntries(entries);
  const first = sorted[0];
  if (first === undefined) return { ok: true };
  const closing = first.closingPosition;
  if (closing === null || closing === undefined) {
    return {
      ok: false,
      error: {
        code: 'LEDGER_FIRST_NEEDS_CLOSING_POSITION',
        message: `earliest entry (${first.date}) must include closingPosition as the chain anchor`,
      },
    };
  }
  return { ok: true };
}

export function isValidationCode(code: ErrorCode): boolean {
  return code === 'LEDGER_FIRST_NEEDS_CLOSING_POSITION' || code === 'LEDGER_DUPLICATE_DATE';
}

/* ---------- enrichment (derived chain) ---------- */

const ZERO = new Decimal(0);
const ONE_HUNDRED = new Decimal(100);

function toDecimal(s: string): Decimal {
  return new Decimal(s);
}

/**
 * Fill in the implicit derived fields:
 *
 *   - derivedClosingPosition: user value when present, otherwise
 *     `prev.derivedClosing + pnlAmount`.
 *   - derivedDailyPct: `pnlAmount / prev.derivedClosing × 100`.
 *     The pre-anchor "prev" is `first.closingPosition − first.pnlAmount`
 *     so the earliest day still has a defined denominator.
 *   - cashFlow: `derivedClosing − prev.derivedClosing − pnlAmount`,
 *     non-zero when the user deposits / withdraws / receives dividends.
 *
 * Pre-condition: `validateLedger(entries).ok === true`. If the caller
 * skips validation we throw on the first missing anchor — that's a
 * programmer error, not a runtime input error.
 */
export function enrichEntries(entries: readonly LedgerEntry[]): readonly EnrichedLedgerEntry[] {
  const sorted = sortEntries(entries);
  if (sorted.length === 0) return [];

  const firstAnchor = sorted[0]?.closingPosition;
  if (firstAnchor === null || firstAnchor === undefined) {
    throw new Error(
      'enrichEntries: earliest entry has no closingPosition (call validateLedger first)',
    );
  }

  // Synthetic "day-zero" position = closingPosition − pnlAmount of the
  // earliest entry. This is the implicit start-of-trading capital.
  const firstEntry = sorted[0];
  if (firstEntry === undefined) return [];
  const firstClosing = toDecimal(firstAnchor);
  const firstPnl = toDecimal(firstEntry.pnlAmount);
  let prevClosing = firstClosing.minus(firstPnl);

  const out: EnrichedLedgerEntry[] = [];
  for (const entry of sorted) {
    out.push(buildEnriched(entry, prevClosing));
    prevClosing = toDecimal(out[out.length - 1]?.derivedClosingPosition ?? '0');
  }
  return out;
}

function buildEnriched(entry: LedgerEntry, prevClosing: Decimal): EnrichedLedgerEntry {
  const pnl = toDecimal(entry.pnlAmount);
  const userClosing = entry.closingPosition;
  const provided = userClosing !== null && userClosing !== undefined;
  const closing = provided ? toDecimal(userClosing) : prevClosing.plus(pnl);
  const cashFlow = closing.minus(prevClosing).minus(pnl);
  const dailyPct = prevClosing.isZero() ? ZERO : pnl.dividedBy(prevClosing).times(ONE_HUNDRED);
  return {
    date: entry.date,
    pnlAmount: entry.pnlAmount,
    ...(userClosing !== undefined && { closingPosition: userClosing }),
    derivedClosingPosition: closing.toString(),
    closingProvided: provided,
    derivedDailyPct: dailyPct.toString(),
    cashFlow: cashFlow.toString(),
  };
}

/* ---------- summary helpers (operate on enriched) ---------- */

export function totalPnlAmount(enriched: readonly EnrichedLedgerEntry[]): string {
  let sum = ZERO;
  for (const e of enriched) sum = sum.plus(toDecimal(e.pnlAmount));
  return sum.toString();
}

/**
 * Total cash flow across the window — useful when the user wants to know
 * how much capital they injected / withdrew vs how much was trading P/L.
 */
export function totalCashFlow(enriched: readonly EnrichedLedgerEntry[]): string {
  let sum = ZERO;
  for (const e of enriched) sum = sum.plus(toDecimal(e.cashFlow));
  return sum.toString();
}

/**
 * Total return % measured **excluding the first (anchor) entry**.
 *
 * Baseline = `first.derivedClosingPosition` (the account balance after
 * the anchor day settles). The first entry's PnL is treated as
 * pre-tracking history and does not factor into the percentage. This
 * matches the user's mental model: "the first record establishes my
 * starting balance; subsequent records are growth from that point".
 *
 * Returns `"0"` for empty / single-entry snapshots, and `"0"` when the
 * baseline is zero (avoids divide-by-zero).
 */
export function totalReturnPct(enriched: readonly EnrichedLedgerEntry[]): string {
  if (enriched.length < 2) return '0';
  const first = enriched[0];
  const last = enriched[enriched.length - 1];
  if (first === undefined || last === undefined) return '0';
  const baseline = toDecimal(first.derivedClosingPosition);
  if (baseline.isZero()) return '0';
  const final = toDecimal(last.derivedClosingPosition);
  return final.minus(baseline).dividedBy(baseline).times(ONE_HUNDRED).toString();
}

export function currentPosition(enriched: readonly EnrichedLedgerEntry[]): string {
  const last = enriched[enriched.length - 1];
  if (last === undefined) return '0';
  return last.derivedClosingPosition;
}

export function initialPosition(enriched: readonly EnrichedLedgerEntry[]): string {
  const first = enriched[0];
  if (first === undefined) return '0';
  return toDecimal(first.derivedClosingPosition).minus(toDecimal(first.pnlAmount)).toString();
}

/**
 * Number of calendar days between the earliest entry and `today`. `today`
 * is injected (Asia/Shanghai or UTC date — caller's choice) so the
 * function stays pure (no `Date.now()` / `Date.parse()` allowed in core).
 *
 * Both inputs are `YYYY-MM-DD` strings; we compute the day delta using
 * the proleptic-Gregorian date-to-ordinal formula (no `Date` global).
 */
export function daysSinceFirst(enriched: readonly EnrichedLedgerEntry[], today: string): number {
  if (enriched.length === 0) return 0;
  const first = enriched[0];
  if (first === undefined) return 0;
  const start = isoToOrdinal(first.date);
  const end = isoToOrdinal(today);
  if (start === null || end === null) return 0;
  const diff = end - start;
  return diff < 0 ? 0 : diff;
}

/**
 * Signed day delta between two `YYYY-MM-DD` dates: `to - from`. Returns
 * `null` if either input is malformed. Pure: same proleptic-Gregorian
 * arithmetic as {@link daysSinceFirst}, no `Date` global.
 */
export function daysBetween(from: string, to: string): number | null {
  const a = isoToOrdinal(from);
  const b = isoToOrdinal(to);
  if (a === null || b === null) return null;
  return b - a;
}

/**
 * Convert a `YYYY-MM-DD` string to a day-since-epoch integer using the
 * Howard-Hinnant civil_from_days algorithm (proleptic Gregorian). No
 * runtime `Date` involved — works in core-asset code under the
 * `no-restricted-globals` rule.
 */
function isoToOrdinal(iso: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(iso);
  if (m === null) return null;
  const yRaw = m[1];
  const moRaw = m[2];
  const dRaw = m[3];
  if (yRaw === undefined || moRaw === undefined || dRaw === undefined) return null;
  const y = Number.parseInt(yRaw, 10);
  const mo = Number.parseInt(moRaw, 10);
  const d = Number.parseInt(dRaw, 10);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const yy = mo <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (mo > 2 ? mo - 3 : mo + 9) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/* ---------- chart series ---------- */

export interface DailyPnlPoint {
  readonly date: string;
  readonly value: string;
  readonly cashFlow: string;
  readonly closingProvided: boolean;
}

export function seriesDailyPnl(enriched: readonly EnrichedLedgerEntry[]): readonly DailyPnlPoint[] {
  return enriched.map((e) => ({
    date: e.date,
    value: e.pnlAmount,
    cashFlow: e.cashFlow,
    closingProvided: e.closingProvided,
  }));
}

export interface CumulativePoint {
  readonly date: string;
  readonly value: string;
  readonly closingProvided: boolean;
}

export function seriesCumulativePosition(
  enriched: readonly EnrichedLedgerEntry[],
): readonly CumulativePoint[] {
  return enriched.map((e) => ({
    date: e.date,
    value: e.derivedClosingPosition,
    closingProvided: e.closingProvided,
  }));
}

/**
 * Daily PnL bars excluding the anchor entry (the first record). The
 * anchor's pnlAmount is treated as pre-tracking history and would
 * dominate the chart's vertical scale if included.
 */
export function seriesDailyPnlNoAnchor(
  enriched: readonly EnrichedLedgerEntry[],
): readonly DailyPnlPoint[] {
  return seriesDailyPnl(enriched.slice(1));
}

/**
 * One K-line candle per non-anchor entry, where:
 *
 *   - `open`  = previous day's `derivedClosingPosition`
 *   - `close` = this day's `derivedClosingPosition`
 *   - `direction` = `'up' | 'down' | 'flat'` based on close vs open
 *
 * High / low are intentionally omitted — the ledger only carries
 * end-of-day snapshots, so wicks would be synthetic. Renderers draw
 * candle bodies only.
 */
export interface KlineCandle {
  readonly date: string;
  readonly open: string;
  readonly close: string;
  readonly direction: 'up' | 'down' | 'flat';
  readonly closingProvided: boolean;
  readonly cashFlow: string;
}

export function seriesKline(enriched: readonly EnrichedLedgerEntry[]): readonly KlineCandle[] {
  const out: KlineCandle[] = [];
  for (let i = 1; i < enriched.length; i++) {
    const prev = enriched[i - 1];
    const cur = enriched[i];
    if (prev === undefined || cur === undefined) continue;
    const openD = toDecimal(prev.derivedClosingPosition);
    const closeD = toDecimal(cur.derivedClosingPosition);
    const cmp = closeD.comparedTo(openD);
    const direction: 'up' | 'down' | 'flat' = cmp > 0 ? 'up' : cmp < 0 ? 'down' : 'flat';
    out.push({
      date: cur.date,
      open: openD.toString(),
      close: closeD.toString(),
      direction,
      closingProvided: cur.closingProvided,
      cashFlow: cur.cashFlow,
    });
  }
  return out;
}
