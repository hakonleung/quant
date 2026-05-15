/**
 * Pure helpers for EQ.LIST — extracted from `feat-eq-list.tsx` so the
 * React component stays under the 400-line ceiling (CLAUDE.md §1.2)
 * and so sort comparators / evidence formatters / row builders can be
 * unit-tested without a DOM.
 *
 * No React, no IO, no global Date / Math.random. The one helper that
 * needed `Date.now()` (`formatRelativeTime`) takes a `now: number`
 * parameter so the caller injects the clock at the boundary.
 */

import type { ColumnFilter, ColumnFilterOp, KlineBar, StockMetaDto } from '@quant/shared';

import { deriveStats, type StockStats } from './stock-stats.js';

/**
 * Apply a numeric predicate to a candidate value. Non-numeric (`null`,
 * `undefined`, strings) yields `null` — the caller is expected to treat
 * "no opinion" rows as passing rather than dropping them silently. This
 * matches the user-facing rule "对于某个列筛选条件，列值为空跳过".
 */
export function evaluateColumnFilter(value: unknown, filter: ColumnFilter): boolean | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return compareWithOp(value, filter.op, filter.value);
}

function compareWithOp(lhs: number, op: ColumnFilterOp, rhs: number): boolean {
  switch (op) {
    case '>':
      return lhs > rhs;
    case '>=':
      return lhs >= rhs;
    case '<':
      return lhs < rhs;
    case '<=':
      return lhs <= rhs;
    case '=':
      return lhs === rhs;
    case '!=':
      return lhs !== rhs;
  }
}

export interface ListRow extends StockStats, Record<string, unknown> {
  readonly code: string;
  readonly name: string;
  readonly statsReady: boolean;
}

/** Built-in column keys covered by the standard stat columns; evidence
 *  keys colliding with these are folded into the standard column rather
 *  than producing a duplicate. */
export const BUILTIN_KEYS: ReadonlySet<string> = new Set([
  'name',
  'code',
  'price',
  'chgPct',
  'turnoverRate',
  'turnover',
  'consecUp',
  'consecUpDays',
  'statsReady',
]);

export type EvidenceColumnKind = 'cny' | 'chgPct' | 'raw';

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === null || proto === Object.prototype;
}

/** Decimal-as-string round-tripped from Python — coerce when the
 *  entire string parses cleanly, leave dates / arbitrary text alone. */
export function coerceNumeric(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  if (!/^-?\d+(?:\.\d+)?$/.test(v)) return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

/**
 * Flatten one stock's evaluator evidence and coerce numeric strings.
 *
 * The screening service emits a nested shape:
 *
 *     { metrics: { amount: "5.3e9", pct_chg_qfq: "0.034", ... },
 *       window:  ["2025-04-03", "2026-04-30"] }
 *
 * The list-panel renders one column per leaf key, so we lift every
 * dict-valued field's children into the parent and turn decimal-as-
 * string values into numbers for sort + format. Non-dict values
 * (arrays, scalars) pass through unchanged.
 */
export function flattenEvidence(
  raw: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (isPlainObject(v)) {
      for (const [inK, inV] of Object.entries(v)) {
        out[inK] = coerceNumeric(inV);
      }
    } else {
      out[k] = coerceNumeric(v);
    }
  }
  return out;
}

/**
 * Adapt a BE-assembled `StockListRow` into the FE's `ListRow` shape.
 * Reuses the same evidence flattening / coerceNumeric pipeline so
 * downstream sort/filter/render see the same per-key normalization
 * they always have. The FE `ListRow.consecUpDays` keeps its legacy
 * name so existing column extractors don't churn.
 */
export function listRowFromStockListRow(
  row: import('@quant/shared').StockListRow,
  rawEvidence: Readonly<Record<string, unknown>> | undefined,
): ListRow {
  const evidence = rawEvidence === undefined ? {} : flattenEvidence(rawEvidence);
  const out: Record<string, unknown> = {
    ...evidence,
    code: row.code,
    name: row.name ?? row.code,
    statsReady: true,
    price: row.price ?? 0,
    chgPct: row.chgPct,
    turnoverRate: row.turnoverRate,
    turnover: row.turnover,
    consecUpDays: row.consecUp ?? 0,
    ret5d: row.ret5d,
    ret10d: row.ret10d,
    ret20d: row.ret20d,
    ret90d: row.ret90d,
    ret250d: row.ret250d,
    mktCap: row.mktCap,
    floatMktCap: row.floatMktCap,
    peTtm: row.peTtm,
    peDynamic: row.peDynamic,
    pb: row.pb,
    peg: row.peg,
    grossMargin: row.grossMargin,
  };
  return out as ListRow;
}

export function buildRows(
  codes: readonly string[],
  meta: ReadonlyMap<string, StockMetaDto>,
  klineByCode: ReadonlyMap<string, readonly KlineBar[]>,
  evidenceMap: Readonly<Record<string, Readonly<Record<string, unknown>>>> | null,
): readonly ListRow[] {
  const rows: ListRow[] = [];
  for (const code of codes) {
    const m = meta.get(code);
    const bars = klineByCode.get(code);
    const stats = bars === undefined ? null : deriveStats(bars);
    const rawEvidence = evidenceMap?.[code] ?? {};
    const evidence = flattenEvidence(rawEvidence);
    // {...stock, ...evidence, ...metrics} — kline-derived metrics win
    // last so they override anything the screening evaluator emitted
    // under the same key (the built-in column already shows the kline
    // value; the evidence column has been filtered out upstream).
    const row: Record<string, unknown> = {
      ...m,
      ...evidence,
      code,
      name: m?.name ?? code,
      statsReady: stats !== null,
      price: stats?.price ?? 0,
      chgPct: stats?.chgPct ?? null,
      turnoverRate: stats?.turnoverRate ?? null,
      turnover: stats?.turnover ?? null,
      consecUpDays: stats?.consecUpDays ?? 0,
    };
    rows.push(row as ListRow);
  }
  return rows;
}

/**
 * Map an evidence key to a render kind. Heuristics mirror the
 * screening evaluator's emitted column names: `amount` → CNY, anything
 * containing `pct` / `period_return` / `rate` → percent, else raw.
 *
 * Insensitive to case so `AMOUNT` / `PERIOD_RETURN_240D` /
 * `TurnoverRate` all hit the right branch.
 */
export function evidenceColumnKind(key: string): EvidenceColumnKind {
  const k = key.toLowerCase();
  if (k === 'amount') return 'cny';
  if (k.includes('pct')) return 'chgPct';
  if (k.includes('period_return')) return 'chgPct';
  if (k.includes('rate')) return 'chgPct';
  return 'raw';
}

export function toNumberOrNull(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    if (!/^-?\d+(?:\.\d+)?$/.test(raw)) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function evidenceSortKey(v: unknown): number | string | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v === null || v === undefined) return null;
  return String(v);
}

export function formatEvidence(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return JSON.stringify(v);
}

export function sortValue(r: ListRow, key: string): number | string | null {
  if (key === 'name') return r.name;
  if (key === 'code') return r.code;
  if (key === 'price') return r.statsReady ? r.price : null;
  if (key === 'chgPct') return r.chgPct;
  if (key === 'turnoverRate') return r.turnoverRate;
  if (key === 'turnover') return r.turnover;
  if (key === 'consecUp') return r.consecUpDays;
  if (key.startsWith('ev:')) {
    const k = key.slice(3);
    return evidenceSortKey(r[k]);
  }
  return null;
}

export function compareValues(
  va: number | string | null,
  vb: number | string | null,
): number {
  if (va === null && vb === null) return 0;
  if (va === null) return -1;
  if (vb === null) return 1;
  if (typeof va === 'number' && typeof vb === 'number') return va - vb;
  return String(va).localeCompare(String(vb));
}

export function compareRows(a: ListRow, b: ListRow, key: string): number {
  return compareValues(sortValue(a, key), sortValue(b, key));
}

/**
 * Human "Ns ago / Nm ago / Nh ago / Nd ago / YYYY-MM-DD" — `now` is
 * the current time in **ms since epoch**, supplied by the caller so
 * this module stays Date-free (CLAUDE.md §1.2 — no global Date in
 * pure helpers). Beyond 30 days the ISO date is rendered.
 */
/* eslint-disable no-restricted-globals -- ISO parsing has no
   Date-free alternative; this function is otherwise pure (iso string
   + now ms → display string) and the `Date` reference is confined
   to the parsing/formatting helper here. */
export function formatRelativeTime(iso: string | undefined, now: number): string {
  if (iso === undefined) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const diffSec = Math.floor((now - t) / 1000);
  if (diffSec < 60) return `${String(diffSec)}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${String(diffMin)}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${String(diffH)}h ago`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 30) return `${String(diffD)}d ago`;
  // Beyond 30 days, show the absolute ISO date.
  const d = new Date(t);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(d.getUTCFullYear())}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
/* eslint-enable no-restricted-globals */
