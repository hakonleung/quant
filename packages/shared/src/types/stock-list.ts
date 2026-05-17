/**
 * Canonical stock-list contract — shared by NestJS instruction handlers,
 * the Feishu IM table renderer, and both `feat-eq-list` (normal mode) +
 * the xterm/term-mode stock display.
 *
 * Single source of truth for: column catalog, default applied set,
 * default sort per `kind`, and the row DTO every consumer round-trips.
 */

import { z } from 'zod';

// ── columns ──────────────────────────────────────────────────────────────

export const STOCK_LIST_COLUMN_KEYS = [
  'name',
  'price',
  'chgPct',
  'turnoverRate',
  'turnover',
  'consecUp',
  'ret5d',
  'ret10d',
  'ret20d',
  'ret90d',
  'ret250d',
  'mktCap',
  'floatMktCap',
  'peTtm',
  'peDynamic',
  'pb',
  'peg',
  'grossMargin',
  // DDE 主力 fund-flow 阶段块（modules/01-stock-meta.md §5）。
  // Inflow 列是 CNY 金额（可负，单位元）；ratio 列是占同期成交额的比值
  // （可负，无量纲，6 dp）。
  'ddeMainInflow3d',
  'ddeMainInflow5d',
  'ddeMainInflow10d',
  'ddeMainInflow20d',
  'ddeMainInflowRatio3d',
  'ddeMainInflowRatio5d',
  'ddeMainInflowRatio10d',
  'ddeMainInflowRatio20d',
] as const;

export type StockListColumnKey = (typeof STOCK_LIST_COLUMN_KEYS)[number];

const COLUMN_KEY_SET: ReadonlySet<string> = new Set(STOCK_LIST_COLUMN_KEYS);
export function isStockListColumnKey(value: string): value is StockListColumnKey {
  return COLUMN_KEY_SET.has(value);
}

export interface StockListColumnSpec {
  readonly key: StockListColumnKey;
  readonly label: string;
  readonly group: 'core' | 'derived';
  readonly defaultApplied: boolean;
  /**
   * Where the value comes from on the BE assemble path:
   *   - `meta`     : already in the meta DTO (industries, name)
   *   - `kline`    : computed from the kline branch (chg%, turnover…)
   *   - `snapshot` : needs the snapshot fetch (mkt cap / PE / PB / PEG / margin)
   */
  readonly source: 'meta' | 'kline' | 'snapshot';
}

export const STOCK_LIST_COLUMN_CATALOG: readonly StockListColumnSpec[] = [
  { key: 'name', label: 'CODE', group: 'core', defaultApplied: true, source: 'meta' },
  { key: 'price', label: 'PRICE', group: 'core', defaultApplied: true, source: 'kline' },
  { key: 'chgPct', label: 'CHG%', group: 'core', defaultApplied: true, source: 'kline' },
  { key: 'turnoverRate', label: '换手', group: 'core', defaultApplied: true, source: 'kline' },
  { key: 'turnover', label: '成交额', group: 'core', defaultApplied: true, source: 'kline' },
  { key: 'consecUp', label: '连涨', group: 'core', defaultApplied: true, source: 'kline' },
  { key: 'ret5d', label: '5D%', group: 'derived', defaultApplied: false, source: 'snapshot' },
  { key: 'ret10d', label: '10D%', group: 'derived', defaultApplied: false, source: 'snapshot' },
  { key: 'ret20d', label: '20D%', group: 'derived', defaultApplied: false, source: 'snapshot' },
  { key: 'ret90d', label: '90D%', group: 'derived', defaultApplied: false, source: 'snapshot' },
  { key: 'ret250d', label: '250D%', group: 'derived', defaultApplied: false, source: 'snapshot' },
  { key: 'mktCap', label: '总市值', group: 'derived', defaultApplied: false, source: 'snapshot' },
  {
    key: 'floatMktCap',
    label: '流通市值',
    group: 'derived',
    defaultApplied: false,
    source: 'snapshot',
  },
  { key: 'peTtm', label: 'PE-TTM', group: 'derived', defaultApplied: false, source: 'snapshot' },
  {
    key: 'peDynamic',
    label: 'PE动态',
    group: 'derived',
    defaultApplied: false,
    source: 'snapshot',
  },
  { key: 'pb', label: 'PB', group: 'derived', defaultApplied: false, source: 'snapshot' },
  { key: 'peg', label: 'PEG', group: 'derived', defaultApplied: false, source: 'snapshot' },
  {
    key: 'grossMargin',
    label: '毛利率',
    group: 'derived',
    defaultApplied: false,
    source: 'snapshot',
  },
  {
    key: 'ddeMainInflow3d',
    label: '3日主力净流入',
    group: 'derived',
    defaultApplied: false,
    source: 'snapshot',
  },
  {
    key: 'ddeMainInflow5d',
    label: '5日主力净流入',
    group: 'derived',
    defaultApplied: false,
    source: 'snapshot',
  },
  {
    key: 'ddeMainInflow10d',
    label: '10日主力净流入',
    group: 'derived',
    defaultApplied: false,
    source: 'snapshot',
  },
  {
    key: 'ddeMainInflow20d',
    label: '20日主力净流入',
    group: 'derived',
    defaultApplied: false,
    source: 'snapshot',
  },
  {
    key: 'ddeMainInflowRatio3d',
    label: '3日主力净流入占比',
    group: 'derived',
    defaultApplied: false,
    source: 'snapshot',
  },
  {
    key: 'ddeMainInflowRatio5d',
    label: '5日主力净流入占比',
    group: 'derived',
    defaultApplied: false,
    source: 'snapshot',
  },
  {
    key: 'ddeMainInflowRatio10d',
    label: '10日主力净流入占比',
    group: 'derived',
    defaultApplied: false,
    source: 'snapshot',
  },
  {
    key: 'ddeMainInflowRatio20d',
    label: '20日主力净流入占比',
    group: 'derived',
    defaultApplied: false,
    source: 'snapshot',
  },
];

const SPEC_BY_KEY: ReadonlyMap<StockListColumnKey, StockListColumnSpec> = new Map(
  STOCK_LIST_COLUMN_CATALOG.map((s) => [s.key, s]),
);

export function getStockListColumnSpec(key: StockListColumnKey): StockListColumnSpec {
  const spec = SPEC_BY_KEY.get(key);
  if (spec === undefined) throw new Error(`unknown stock-list column key: ${key}`);
  return spec;
}

export const DEFAULT_APPLIED_STOCK_LIST_COLUMNS: readonly StockListColumnKey[] =
  STOCK_LIST_COLUMN_CATALOG.filter((s) => s.defaultApplied).map((s) => s.key);

export function appliedNeedsSnapshot(applied: readonly StockListColumnKey[]): boolean {
  for (const key of applied) {
    if (getStockListColumnSpec(key).source === 'snapshot') return true;
  }
  return false;
}

// ── list kinds + default sort ────────────────────────────────────────────

export const STOCK_LIST_KINDS = ['user-sector', 'dynamic-sector', 'watch', 'screen'] as const;
export type StockListKind = (typeof STOCK_LIST_KINDS)[number];

export const StockListKindSchema = z.enum(STOCK_LIST_KINDS);

export interface StockListSort {
  readonly key: StockListColumnKey;
  readonly dir: 'asc' | 'desc';
}

/**
 * Default sort the BE applies (and FE mirrors when the user has no
 * preference). Tuned per kind: dynamic sectors lead with chg%, watch
 * leads with name, etc. Single source so all three render surfaces
 * agree on the unsorted-but-still-deterministic baseline.
 */
export const DEFAULT_SORT_BY_KIND: Readonly<Record<StockListKind, StockListSort>> = {
  'user-sector': { key: 'name', dir: 'asc' },
  'dynamic-sector': { key: 'chgPct', dir: 'desc' },
  watch: { key: 'name', dir: 'asc' },
  screen: { key: 'chgPct', dir: 'desc' },
};

// ── row DTO ──────────────────────────────────────────────────────────────

/**
 * The unified row shape every render path expects. Every numeric column
 * is nullable because not every store has every value (e.g. snapshot
 * fetch may be deferred or fail). The key set matches
 * `StockListColumnKey` plus the always-present `code`.
 */
export const StockListRowSchema = z
  .object({
    code: z.string().min(1),
    name: z.string().nullable(),
    price: z.number().nullable(),
    chgPct: z.number().nullable(),
    turnoverRate: z.number().nullable(),
    turnover: z.number().nullable(),
    consecUp: z.number().int().nullable(),
    ret5d: z.number().nullable(),
    ret10d: z.number().nullable(),
    ret20d: z.number().nullable(),
    ret90d: z.number().nullable(),
    ret250d: z.number().nullable(),
    mktCap: z.number().nullable(),
    floatMktCap: z.number().nullable(),
    peTtm: z.number().nullable(),
    peDynamic: z.number().nullable(),
    pb: z.number().nullable(),
    peg: z.number().nullable(),
    grossMargin: z.number().nullable(),
    ddeMainInflow3d: z.number().nullable(),
    ddeMainInflow5d: z.number().nullable(),
    ddeMainInflow10d: z.number().nullable(),
    ddeMainInflow20d: z.number().nullable(),
    ddeMainInflowRatio3d: z.number().nullable(),
    ddeMainInflowRatio5d: z.number().nullable(),
    ddeMainInflowRatio10d: z.number().nullable(),
    ddeMainInflowRatio20d: z.number().nullable(),
    /**
     * Optional evidence map for dynamic-sector rows (column key →
     * pre-formatted display string). Other kinds leave this empty.
     */
    evidence: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type StockListRow = z.infer<typeof StockListRowSchema>;

export const StockListRowsResponseSchema = z
  .object({
    kind: StockListKindSchema,
    columns: z.array(z.enum(STOCK_LIST_COLUMN_KEYS)),
    sort: z.object({
      key: z.enum(STOCK_LIST_COLUMN_KEYS),
      dir: z.enum(['asc', 'desc']),
    }),
    rows: z.array(StockListRowSchema),
  })
  .strict();
export type StockListRowsResponse = z.infer<typeof StockListRowsResponseSchema>;

/**
 * Build a `StockListRow` with every numeric column set to `null`.
 * Use as a base then spread overrides — keeps callers from going
 * stale every time the column set grows.
 */
export function emptyStockListRow(code: string, name: string | null = null): StockListRow {
  return {
    code,
    name,
    price: null,
    chgPct: null,
    turnoverRate: null,
    turnover: null,
    consecUp: null,
    ret5d: null,
    ret10d: null,
    ret20d: null,
    ret90d: null,
    ret250d: null,
    mktCap: null,
    floatMktCap: null,
    peTtm: null,
    peDynamic: null,
    pb: null,
    peg: null,
    grossMargin: null,
    ddeMainInflow3d: null,
    ddeMainInflow5d: null,
    ddeMainInflow10d: null,
    ddeMainInflow20d: null,
    ddeMainInflowRatio3d: null,
    ddeMainInflowRatio5d: null,
    ddeMainInflowRatio10d: null,
    ddeMainInflowRatio20d: null,
  };
}

export const StockListRowsRequestSchema = z
  .object({
    kind: StockListKindSchema,
    codes: z.array(z.string().min(1)),
    /** Optional override of the applied column set; defaults to DEFAULT_APPLIED. */
    columns: z.array(z.enum(STOCK_LIST_COLUMN_KEYS)).optional(),
    /** Optional sort override; defaults to DEFAULT_SORT_BY_KIND[kind]. */
    sort: z
      .object({
        key: z.enum(STOCK_LIST_COLUMN_KEYS),
        dir: z.enum(['asc', 'desc']),
      })
      .optional(),
  })
  .strict();
export type StockListRowsRequest = z.infer<typeof StockListRowsRequestSchema>;
