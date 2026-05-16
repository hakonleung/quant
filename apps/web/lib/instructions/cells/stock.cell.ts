/**
 * FE `/stock` cell — search or picker.
 *
 * - Bare `stock` → opens an interactive picker against `host.stockIndex`
 *   (pure FE; no BE round-trip).
 * - `stock <query>` → invokes the BE search instruction and renders the
 *   typed `StockListRow[]` payload as a table.
 *
 * Picker commit dispatches `stock.info <code>`; pressing `a` analyses
 * the row, `f` focuses it.
 */

import type { InstructionCell, ResultOf } from '@quant/shared';
import { interactive, selectableList, textOk } from '@quant/terminal';

import type { FeEnv } from '../fe-types.js';

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
      const lines: string[] = [`stock search "${r.query}" — ${String(r.rows.length)} row(s)`];
      for (const row of r.rows) {
        lines.push(`  ${row.code}  ${row.name}  ${String(row.price ?? '—')}`);
      }
      return textOk(lines.join('\n'));
    },
  };
}
