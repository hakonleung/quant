/**
 * FE `/stock` cell — search or picker.
 *
 * - Bare `stock` → opens an interactive picker against `host.stockIndex`
 *   (pure FE; no BE round-trip). Meta-only — no price/snapshot data.
 * - `stock <query>` → invokes the BE search instruction and renders
 *   the typed `StockListRow[]` payload in the shared "stock table"
 *   mode (CODE / PRICE / CHG% / 换手 / 成交额 / 连涨) so search results
 *   read identically to the MKT pane's normal-mode list.
 *
 * Both surfaces commit Enter to `stock.info <code>`; `a` analyses the
 * row, `f` focuses it.
 */

import type { InstructionCell, ResultOf } from '@quant/shared';
import { interactive, selectableList, textOk } from '@quant/terminal';

import type { FeEnv } from '../fe-types.js';
import { buildStockTable } from './stock-table.js';

type StockSearchResult = ResultOf<'stock'>;

const PICKER_SENTINEL = '__picker__';

export function buildStockCell(): InstructionCell<FeEnv, 'stock'> {
  return {
    async handler(args, ctx): Promise<StockSearchResult> {
      if (args.q === undefined || args.q.length === 0) {
        return { query: PICKER_SENTINEL, rows: [] };
      }
      const env = await ctx.api.invoke('stock', args, { signal: ctx.signal });
      if (!env.ok) throw new Error(env.error.message);
      return env.data;
    },
    renderer(envelope, host) {
      if (!envelope.ok) {
        return { kind: 'text', status: 'err', tail: { body: envelope.error.message } };
      }
      const r = envelope.data;
      if (r.query === PICKER_SENTINEL) {
        const items = host.stockIndex.all().map((m) => ({
          code: m.code,
          name: m.name,
          industry: m.industry ?? '',
        }));
        return interactive(
          selectableList({
            title: 'stock — pick (filter with /)',
            items,
            columns: [
              { key: 'code', header: 'CODE', max: 8 },
              { key: 'name', header: 'NAME', max: 14 },
              { key: 'industry', header: 'IND', max: 12 },
            ],
            onCommit: (s) => ({
              kind: 'command',
              line: `stock.info ${String(s.code)}`,
            }),
            extraKeys: [
              {
                key: 'a',
                hint: { keys: ['a'], label: 'analyze (paid)', danger: true },
                resolve: (s) => ({ kind: 'command', line: `analyze ${String(s.code)}` }),
              },
              {
                key: 'f',
                hint: { keys: ['f'], label: 'focus' },
                resolve: (s) => ({ kind: 'command', line: `focus ${String(s.code)}` }),
              },
            ],
          }),
        );
      }
      if (r.rows.length === 0) {
        return textOk(`no match for "${r.query}"`);
      }
      return buildStockTable({
        title: `stock search "${r.query}"  ·  ${String(r.rows.length)} row(s)`,
        rows: r.rows,
      });
    },
  };
}
