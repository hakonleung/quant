/**
 * In-process replacement for `UniverseScreenService.filter_codes` —
 * applies a {@link UniversePlanAst} to the local meta cache and
 * returns matched codes (sorted asc).
 */

import { Inject, Injectable } from '@nestjs/common';
import type { UniversePlanAst } from '@quant/shared';

import { LocalStockMetaAdapter } from '../stock-meta/local-stock-meta.adapter.js';
import { evaluateUniverse } from './domain/pure/universe-eval.js';

@Injectable()
export class UniverseFilterService {
  constructor(@Inject(LocalStockMetaAdapter) private readonly metaAdapter: LocalStockMetaAdapter) {}

  async filterCodes(plan: UniversePlanAst): Promise<string[]> {
    const metas = await this.metaAdapter.listAll();
    const matched = evaluateUniverse(plan, metas);
    return matched.map((m) => m.code).sort();
  }
}
