/**
 * Static catalog of E-1 list columns (`docs/modules/07-frontend.md` §4.1.1).
 *
 * The list panel renders columns in two passes:
 *   1. user-applied columns from this catalog, in user-chosen order
 *   2. dynamic-sector evidence columns, always last
 *
 * Adding a metric:
 *   - append a {@link ColumnSpec} below
 *   - hand the rendering branch to `buildColumns()` in
 *     `components/eqty/list-panel.tsx`
 *   - if the metric needs server-side derivation, set `source: 'snapshot'`
 *     so `useStockSnapshots` is wired up only when at least one such
 *     column is applied (avoids a 5500-code request when the user has
 *     no derived columns turned on)
 */

export const COLUMN_KEYS = [
  'name',
  'price',
  'chgPct',
  'turnoverRate',
  'turnover',
  'consecUp',
  'mktCap',
  'floatMktCap',
  'peTtm',
  'peDynamic',
  'pb',
  'peg',
  'grossMargin',
] as const;

export type ColumnKey = (typeof COLUMN_KEYS)[number];

const COLUMN_KEY_SET: ReadonlySet<string> = new Set(COLUMN_KEYS);

/** Type guard — narrows arbitrary user input from settings store / URL. */
export function isColumnKey(value: string): value is ColumnKey {
  return COLUMN_KEY_SET.has(value);
}

export interface ColumnSpec {
  readonly key: ColumnKey;
  readonly label: string;
  readonly group: 'core' | 'derived';
  readonly defaultApplied: boolean;
  /**
   * Where the value comes from — gates the snapshot fetch:
   *   - `meta`     : already in the meta DTO (industries, name)
   *   - `kline`    : computed in the bulk-kline branch (chg%, turnover…)
   *   - `snapshot` : needs `useStockSnapshots(codes)` (mkt cap / PE / PB / PEG / margin)
   */
  readonly source: 'meta' | 'kline' | 'snapshot';
}

export const COLUMN_CATALOG: readonly ColumnSpec[] = [
  { key: 'name', label: 'CODE', group: 'core', defaultApplied: true, source: 'meta' },
  { key: 'price', label: 'PRICE', group: 'core', defaultApplied: true, source: 'kline' },
  { key: 'chgPct', label: 'CHG%', group: 'core', defaultApplied: true, source: 'kline' },
  {
    key: 'turnoverRate',
    label: '换手',
    group: 'core',
    defaultApplied: true,
    source: 'kline',
  },
  {
    key: 'turnover',
    label: '成交额',
    group: 'core',
    defaultApplied: true,
    source: 'kline',
  },
  {
    key: 'consecUp',
    label: '连涨',
    group: 'core',
    defaultApplied: true,
    source: 'kline',
  },
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
];

const SPEC_BY_KEY: ReadonlyMap<ColumnKey, ColumnSpec> = new Map(
  COLUMN_CATALOG.map((s) => [s.key, s]),
);

export function getColumnSpec(key: ColumnKey): ColumnSpec {
  const spec = SPEC_BY_KEY.get(key);
  if (spec === undefined) throw new Error(`unknown column key: ${key}`);
  return spec;
}

/** Catalog-default applied list, used by settings store v1→v2 migration. */
export const DEFAULT_APPLIED_COLUMNS: readonly ColumnKey[] = COLUMN_CATALOG.filter(
  (s) => s.defaultApplied,
).map((s) => s.key);

/** Whether the applied list includes any column that needs the snapshot fetch. */
export function appliedNeedsSnapshot(applied: readonly ColumnKey[]): boolean {
  for (const key of applied) {
    if (getColumnSpec(key).source === 'snapshot') return true;
  }
  return false;
}
