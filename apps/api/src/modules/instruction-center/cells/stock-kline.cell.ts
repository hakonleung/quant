/**
 * `/stock.kline` cell — range-scoped daily bars for one code.
 *
 * `range` maps to a tail-bar count: 30D → 30 bars, 90D → 90, 250D → 250.
 * Trading-day vs calendar-day is intentionally simplified to "last N
 * stored bars" — the FE's existing widget treats the count as an
 * approximation already.
 */

import type {
  InstructionCell,
  InstructionResult,
  ResultOf,
} from '@quant/shared';

import { KlineReaderService } from '../../kline/kline-reader.service.js';
import type { BeEnv } from '../be-types.js';

type StockKlineResult = ResultOf<'stock.kline'>;

const RANGE_TO_N: Record<'30D' | '90D' | '250D', number> = {
  '30D': 30,
  '90D': 90,
  '250D': 250,
};

export interface StockKlineCellDeps {
  readonly kline: KlineReaderService;
}

export function buildStockKlineCell(
  deps: StockKlineCellDeps,
): InstructionCell<BeEnv, 'stock.kline'> {
  return {
    async handler(args): Promise<StockKlineResult> {
      const n = RANGE_TO_N[args.range];
      const bars = await deps.kline.lastNForCode(args.code, n);
      return { code: args.code, range: args.range, bars: [...bars] };
    },
    renderer(envelope): InstructionResult {
      if (!envelope.ok) return { ok: false, error: envelope.error };
      const r = envelope.data;
      return {
        ok: true,
        output: {
          text: `${r.code} kline ${r.range}  bars=${String(r.bars.length)}`,
        },
      };
    },
  };
}
