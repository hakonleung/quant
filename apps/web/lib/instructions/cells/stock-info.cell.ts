/**
 * FE `/stock.info` cell — thin proxy to BE composite info view.
 *
 * Renderer mirrors the legacy `runInfo` layout: header + KV table +
 * sparkline of the recent close prices.
 */

import type { InstructionCell, ResultOf } from '@quant/shared';
import { ANSI, paint, sparkline, textOk } from '@quant/terminal';

import type { FeEnv } from '../fe-types.js';

type StockInfoResult = ResultOf<'stock.info'>;

export function buildStockInfoCell(): InstructionCell<FeEnv, 'stock.info'> {
  return {
    async handler(args, ctx): Promise<StockInfoResult> {
      const env = await ctx.api.invoke('stock.info', args, { signal: ctx.signal });
      if (!env.ok) throw new Error(env.error.message);
      return env.data;
    },
    renderer(envelope) {
      if (!envelope.ok) {
        return { kind: 'text', status: 'err', tail: { body: envelope.error.message } };
      }
      const r = envelope.data;
      const lines: string[] = [];
      lines.push(paint(`${r.meta.code}  ${r.meta.name}`, ANSI.bold, ANSI.cyan));
      lines.push(`industry: ${r.meta.industries.length > 0 ? r.meta.industries : '—'}`);
      if (r.snapshot !== null) {
        lines.push(`price:    ${String(r.snapshot.price ?? '—')}`);
        lines.push(`pe_ttm:   ${String(r.snapshot.derived.pe_ttm ?? '—')}`);
        lines.push(`pb:       ${String(r.snapshot.derived.pb ?? '—')}`);
      }
      const last = r.recentBars.at(-1);
      if (last !== undefined) {
        lines.push(`asof:     ${last.date}`);
        lines.push(
          `O/H/L/C:  ${String(last.open)} / ${String(last.high)} / ${String(last.low)} / ${String(last.close)}`,
        );
      }
      if (r.recentBars.length > 0) {
        lines.push(paint(sparkline(r.recentBars.map((b) => b.close)), ANSI.cyan));
      }
      return textOk(lines.join('\n'));
    },
  };
}
