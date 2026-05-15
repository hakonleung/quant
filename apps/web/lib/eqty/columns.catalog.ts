/**
 * FE-side passthrough to the canonical catalog at
 * `packages/shared/src/types/stock-list.ts`.
 *
 * Names are kept (`COLUMN_KEYS`, `COLUMN_CATALOG`, `ColumnKey`,
 * `ColumnSpec`, `DEFAULT_APPLIED_COLUMNS`, `getColumnSpec`,
 * `isColumnKey`, `appliedNeedsSnapshot`) so existing callers don't
 * change. New code should import from `@quant/shared` directly.
 */

import {
  STOCK_LIST_COLUMN_CATALOG,
  STOCK_LIST_COLUMN_KEYS,
  DEFAULT_APPLIED_STOCK_LIST_COLUMNS,
  appliedNeedsSnapshot as appliedNeedsSnapshotShared,
  getStockListColumnSpec,
  isStockListColumnKey,
  type StockListColumnKey,
  type StockListColumnSpec,
} from '@quant/shared';

export const COLUMN_KEYS = STOCK_LIST_COLUMN_KEYS;
export type ColumnKey = StockListColumnKey;
export type ColumnSpec = StockListColumnSpec;
export const COLUMN_CATALOG = STOCK_LIST_COLUMN_CATALOG;
export const DEFAULT_APPLIED_COLUMNS = DEFAULT_APPLIED_STOCK_LIST_COLUMNS;
export const isColumnKey = isStockListColumnKey;
export const getColumnSpec = getStockListColumnSpec;
export const appliedNeedsSnapshot = appliedNeedsSnapshotShared;
