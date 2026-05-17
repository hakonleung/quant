/**
 * Decode an Arrow `Table` produced by the Python
 * `list_stock_fund_flow_ranks` Flight op into the raw per-window map
 * shape NestJS's `StockFundFlowSyncService` consumes.
 *
 * Each row carries the bare 6-digit code and one nullable decimal-string
 * column per configured window (`main_net_inflow_<N>d`). The decoder is
 * lenient on missing columns: if a future server omits a window we keep
 * the others rather than crashing the batch.
 */

import type { Table } from 'apache-arrow';
import { DDE_WINDOWS, type DdeWindow } from '@quant/shared';

export interface FundFlowRankRow {
  readonly code: string;
  readonly mainNetInflowByWindow: ReadonlyMap<DdeWindow, string | null>;
}

export function arrowTableToFundFlowRanks(table: Table): FundFlowRankRow[] {
  const out: FundFlowRankRow[] = [];
  for (let i = 0; i < table.numRows; i++) {
    const proxy = table.get(i);
    if (proxy === null) continue;
    const raw = proxy.toJSON() as Record<string, unknown>;
    const code = requireSixDigitCode(raw['code']);
    const map = new Map<DdeWindow, string | null>();
    for (const window of DDE_WINDOWS) {
      const col = `main_net_inflow_${String(window)}d`;
      map.set(window, optionalString(raw[col]));
    }
    out.push({ code, mainNetInflowByWindow: map });
  }
  return out;
}

function requireSixDigitCode(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error(`fund-flow arrow: code must be string, got ${typeof value}`);
  }
  if (!/^\d{6}$/.test(value)) {
    throw new Error(`fund-flow arrow: code must be 6-digit, got ${value}`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value === '' ? null : value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  throw new Error(`fund-flow arrow: optional decimal must be string-like, got ${typeof value}`);
}
