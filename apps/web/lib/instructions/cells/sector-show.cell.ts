/**
 * FE `/sector.show <id>` cell — sector detail + member rows.
 *
 * Renders a stock-table widget that mirrors the MKT pane's columns
 * (CODE / PRICE / CHG% / 换手 / 成交额 / 连涨), with dynamic-sector
 * evidence keys appended as extra columns. When `stockRows` is null
 * (snapshot assembly failed upstream), falls back to a bare code list
 * so the user still sees membership.
 */

import type { InstructionCell, ResultOf, StockListRow } from '@quant/shared';
import { textErr, textOk } from '@quant/terminal';

import type { FeEnv } from '../fe-types.js';
import { buildStockTable } from './stock-table.js';

type SectorShowResult = ResultOf<'sector.show'>;

export function buildSectorShowCell(): InstructionCell<FeEnv, 'sector.show'> {
  return {
    async handler(args, ctx): Promise<SectorShowResult> {
      const env = await ctx.api.invoke('sector.show', args, { signal: ctx.signal });
      if (!env.ok) throw new Error(env.error.message);
      return env.data;
    },
    renderer(envelope) {
      if (!envelope.ok) return textErr(envelope.error.message);
      const s = envelope.data;
      const subtitle = [
        `${s.kind}`,
        s.published ? 'published' : 'private',
        s.isOwn ? 'own' : `by ${s.createdBy}`,
        `${String(s.totalCount)} members`,
      ].join(' · ');
      const title = `${s.id}  ${s.name}  —  ${subtitle}`;

      if (s.stockRows === null || s.stockRows.length === 0) {
        return s.codes.length === 0
          ? textOk(`${title}\n(empty)`)
          : textOk(`${title}\n${s.codes.join('  ')}`);
      }
      const rows: readonly StockListRow[] = s.stockRows;
      return buildStockTable({
        title,
        rows,
        evidenceKeys: s.evidenceKeys,
        evidenceByCode: s.evidenceByCode,
      });
    },
  };
}
