/**
 * FE `/stock.kline` cell — thin proxy to BE range-scoped bar list.
 *
 * Renderer mirrors the legacy `runKline` layout: header + sparkline +
 * tail-5 OHLC table.
 */

import type { InstructionCell, ResultOf } from '@quant/shared';
import { ANSI, paint, sparkline, textOk } from '@quant/terminal';

import type { FeEnv } from '../fe-types.js';

type StockKlineResult = ResultOf<'stock.kline'>;

export function buildStockKlineCell(): InstructionCell<FeEnv, 'stock.kline'> {
  return {
    async handler(args, ctx): Promise<StockKlineResult> {
      const env = await ctx.api.invoke('stock.kline', args, { signal: ctx.signal });
      if (!env.ok) throw new Error(env.error.message);
      return env.data;
    },
    renderer(envelope) {
      if (!envelope.ok) {
        return { kind: 'text', status: 'err', tail: { body: envelope.error.message } };
      }
      const r = envelope.data;
      const lines: string[] = [];
      lines.push(
        paint(
          `${r.code} kline ${r.range}  bars=${String(r.bars.length)}`,
          ANSI.bold,
          ANSI.cyan,
        ),
      );
      if (r.bars.length > 0) {
        lines.push(paint(sparkline(r.bars.map((b) => b.close)), ANSI.cyan));
      }
      for (const b of r.bars.slice(-5)) {
        lines.push(
          `  ${b.date}  O=${String(b.open)} H=${String(b.high)} L=${String(b.low)} C=${String(b.close)}`,
        );
      }
      return textOk(lines.join('\n'));
    },
  };
}
