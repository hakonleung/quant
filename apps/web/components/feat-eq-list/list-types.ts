/**
 * Shared types + layout constants used by the EQ.LIST internals.
 * Kept in a non-`'use client'` file so column builders and the
 * ScrollGrid can both import them without circular dependency.
 */

import type { ListRow } from '../../lib/fp/eq-list-fp.js';

export const DELETE_COL_W = 32;
export const INDEX_COL_WIDTH = 36;
export const STICKY_COL_WIDTH = 110;
export const ROW_H = 26;

export interface ColumnDef {
  readonly key: string;
  readonly label: string;
  readonly w: number;
  readonly align: 'left' | 'right';
  readonly sticky?: boolean;
  /** Row's index in the currently-rendered list, 0-based. Used by the
   *  ordinal column; ignored by all others. */
  readonly render: (row: ListRow, rowIndex: number) => React.ReactNode;
  readonly sortValue: (row: ListRow) => number | string | null;
  /** Header click cycles sort by default. Set false for purely visual
   *  columns (ordinal "#") that have no meaningful sort. */
  readonly sortable?: boolean;
}

export interface SortState {
  readonly key: string;
  readonly dir: 'asc' | 'desc';
}
