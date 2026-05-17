/**
 * Closed sets of identifiers the screen + universe DSLs accept. Mirrors
 * `services/py/quant_core/domain/types/screen.py:FIELD_NAMES` and
 * `services/py/quant_core/domain/types/universe_screen.py:UNIVERSE_FIELDS`.
 *
 * Any rename or new field must land in both files; the Py side is now
 * removed for screen, so this module is the single source of truth.
 */

export const SCREEN_FIELD_NAMES = [
  'open_qfq',
  'high_qfq',
  'low_qfq',
  'close_qfq',
  'volume',
  'amount',
  'turnover_rate',
  'ma5',
  'ma10',
  'ma20',
  'ma60',
  'pct_chg_qfq',
] as const;
export type ScreenFieldName = (typeof SCREEN_FIELD_NAMES)[number];

export const SCREEN_FIELD_SET: ReadonlySet<string> = new Set(SCREEN_FIELD_NAMES);

export const COMPARE_OPS = ['gt', 'lt', 'gte', 'lte', 'eq', 'neq'] as const;
export type CompareOp = (typeof COMPARE_OPS)[number];
export const COMPARE_OP_SET: ReadonlySet<string> = new Set(COMPARE_OPS);

export const LOGICAL_OPS = ['and', 'or', 'not'] as const;
export type LogicalOp = (typeof LOGICAL_OPS)[number];

export const AGG_OPS = ['mean', 'sum', 'min', 'max', 'count'] as const;
export type AggOp = (typeof AGG_OPS)[number];
export const AGG_OP_SET: ReadonlySet<string> = new Set(AGG_OPS);

export const UNIVERSE_FIELD_NAMES = [
  // ---- meta (always populated from StockMetaDto)
  'code',
  'name',
  'industries',
  'list_date',
  'float_pct',
  'is_st',
  'exchange',
  'listed_days',
  // ---- snapshot scalars + derived (from StockSnapshotDto). Resolve to
  // null when the post-kline-sync projector hasn't filled the row yet
  // (legacy parquet rows, brand-new listings). A null left-hand-side
  // makes any compare evaluate false — equivalent to "exclude this row".
  'price',
  'mkt_cap',
  'float_mkt_cap',
  'pe_ttm',
  'pe_dynamic',
  'pb',
  'peg',
  'gross_margin_ttm',
  // ---- period returns (fractional; e.g. 0.0532 = +5.32%)
  'ret_1d',
  'ret_5d',
  'ret_10d',
  'ret_20d',
  'ret_90d',
  'ret_250d',
  // ---- DDE 主力 fund-flow phase block (modules/01-stock-meta.md §5).
  // Inflow values are CNY amounts (signed); ratio values are
  // inflow / trailing-N-day amount sum (signed decimal).
  'dde_main_net_inflow_3d',
  'dde_main_net_inflow_5d',
  'dde_main_net_inflow_10d',
  'dde_main_net_inflow_20d',
  'dde_main_inflow_ratio_3d',
  'dde_main_inflow_ratio_5d',
  'dde_main_inflow_ratio_10d',
  'dde_main_inflow_ratio_20d',
] as const;
export type UniverseFieldName = (typeof UNIVERSE_FIELD_NAMES)[number];
export const UNIVERSE_FIELD_SET: ReadonlySet<string> = new Set(UNIVERSE_FIELD_NAMES);

/**
 * The subset of universe fields that require a {@link StockSnapshotDto}
 * to resolve (the rest are pure meta). Callers of the universe DSL must
 * supply the snapshot map when any of these is referenced; otherwise
 * those fields resolve to `null` and every comparison against them
 * evaluates false — equivalent to "exclude this row".
 */
export const UNIVERSE_SNAPSHOT_FIELD_NAMES = [
  'price',
  'mkt_cap',
  'float_mkt_cap',
  'pe_ttm',
  'pe_dynamic',
  'pb',
  'peg',
  'gross_margin_ttm',
  'ret_1d',
  'ret_5d',
  'ret_10d',
  'ret_20d',
  'ret_90d',
  'ret_250d',
  'dde_main_net_inflow_3d',
  'dde_main_net_inflow_5d',
  'dde_main_net_inflow_10d',
  'dde_main_net_inflow_20d',
  'dde_main_inflow_ratio_3d',
  'dde_main_inflow_ratio_5d',
  'dde_main_inflow_ratio_10d',
  'dde_main_inflow_ratio_20d',
] as const;
export const UNIVERSE_SNAPSHOT_FIELD_SET: ReadonlySet<string> = new Set(
  UNIVERSE_SNAPSHOT_FIELD_NAMES,
);

export const UNIVERSE_COMPARE_OPS = [
  'gt',
  'lt',
  'gte',
  'lte',
  'eq',
  'neq',
  'contains',
  'starts_with',
  'not_starts_with',
] as const;
export type UniverseCompareOp = (typeof UNIVERSE_COMPARE_OPS)[number];
export const UNIVERSE_COMPARE_OP_SET: ReadonlySet<string> = new Set(UNIVERSE_COMPARE_OPS);
