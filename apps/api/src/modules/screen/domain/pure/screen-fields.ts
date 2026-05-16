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
  'code',
  'name',
  'industries',
  'list_date',
  'float_pct',
  'is_st',
  'exchange',
  'listed_days',
] as const;
export type UniverseFieldName = (typeof UNIVERSE_FIELD_NAMES)[number];
export const UNIVERSE_FIELD_SET: ReadonlySet<string> = new Set(UNIVERSE_FIELD_NAMES);

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
