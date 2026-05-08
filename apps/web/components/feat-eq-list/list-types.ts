/**
 * Shared types + layout constants used by the EQ.LIST internals.
 * Kept in a non-`'use client'` file so column builders and the
 * ScrollGrid can both import them without circular dependency.
 */

import type { ListRow } from '../../lib/fp/eq-list-fp.js';

export const DELETE_COL_W = 32;
export const STICKY_COL_WIDTH = 110;
export const ROW_H = 26;

export interface ColumnDef {
  readonly key: string;
  readonly label: string;
  readonly w: number;
  readonly align: 'left' | 'right';
  readonly sticky?: boolean;
  readonly render: (row: ListRow) => React.ReactNode;
  readonly sortValue: (row: ListRow) => number | string | null;
}

export interface SortState {
  readonly key: string;
  readonly dir: 'asc' | 'desc';
}
