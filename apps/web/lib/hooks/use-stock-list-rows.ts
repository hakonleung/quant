'use client';

/**
 * Single-fetch hook for the unified stock-list contract — calls
 * `POST /api/stock-list/rows` and returns the BE-assembled
 * `StockListRow[]` already validated against the shared zod schema.
 *
 * Replaces the legacy 3-fetch stitch (`getStockMeta` × N +
 * `listKlineBulk` + `listStockSnapshots`) used by `feat-eq-list`. The
 * full panel migration ships in a follow-up so the change can be
 * browser-verified end-to-end; new consumers should adopt this hook
 * directly.
 */

import {
  type StockListColumnKey,
  type StockListKind,
  type StockListRow,
  type StockListRowsResponse,
  type StockListSort,
} from '@quant/shared';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { postStockListRows } from '../api/endpoints.js';

export interface UseStockListRowsArgs {
  readonly kind: StockListKind;
  readonly codes: readonly string[];
  readonly columns?: readonly StockListColumnKey[];
  readonly sort?: StockListSort;
  readonly enabled?: boolean;
}

/**
 * `enabled` defaults to `codes.length > 0` so the synthetic All-sector
 * path (which sends `[]` to mean "full universe" on other endpoints)
 * is opt-in for now — flip it explicitly once §1d-2 lands.
 */
export function useStockListRows(args: UseStockListRowsArgs): UseQueryResult<StockListRowsResponse> {
  const enabled = args.enabled ?? args.codes.length > 0;
  const codeKey = [...args.codes].sort().join(',');
  const columnKey =
    args.columns === undefined ? '' : [...args.columns].join(',');
  const sortKey = args.sort === undefined ? '' : `${args.sort.key}:${args.sort.dir}`;
  return useQuery({
    queryKey: ['stock-list-rows', args.kind, codeKey, columnKey, sortKey],
    queryFn: () =>
      postStockListRows({
        kind: args.kind,
        codes: [...args.codes],
        ...(args.columns !== undefined ? { columns: [...args.columns] } : {}),
        ...(args.sort !== undefined ? { sort: args.sort } : {}),
      }),
    enabled,
    staleTime: 30 * 1000,
  });
}

export type { StockListRow };
