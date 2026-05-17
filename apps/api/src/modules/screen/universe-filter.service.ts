/**
 * In-process replacement for `UniverseScreenService.filter_codes` —
 * applies a {@link UniversePlanAst} to the local meta cache + snapshot
 * projection and returns matched codes (sorted asc).
 *
 * The full-universe snapshot is loaded alongside the meta list so
 * snapshot-derived universe fields (`mkt_cap` / `pe_ttm` / `ret_5d` /
 * DDE 主力净流入 …) resolve in the evaluator. Codes whose snapshot
 * isn't populated yet fall through to "null LHS → exclude" rather than
 * crashing — same semantics as missing kline data downstream.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { StockSnapshotDto, UniversePlanAst } from '@quant/shared';

import { LocalStockMetaAdapter } from '../stock-meta/local-stock-meta.adapter.js';
import { evaluateUniverse, type SnapshotByCode } from './domain/pure/universe-eval.js';

@Injectable()
export class UniverseFilterService {
  constructor(@Inject(LocalStockMetaAdapter) private readonly metaAdapter: LocalStockMetaAdapter) {}

  async filterCodes(plan: UniversePlanAst): Promise<string[]> {
    const [metas, snapshots] = await Promise.all([
      this.metaAdapter.listAll(),
      // Empty `codes` expands to the full universe per the adapter
      // contract — one cache read, no per-code N+1.
      this.metaAdapter.listSnapshots([]),
    ]);
    const snapshotByCode: SnapshotByCode = toSnapshotMap(snapshots);
    const matched = evaluateUniverse(plan, metas, snapshotByCode);
    return matched.map((m) => m.code).sort();
  }
}

function toSnapshotMap(snapshots: readonly StockSnapshotDto[]): SnapshotByCode {
  const out = new Map<string, StockSnapshotDto>();
  for (const s of snapshots) out.set(s.meta.code, s);
  return out;
}
