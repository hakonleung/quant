/**
 * Pure rendering for `/stock` (search). Empty rows → "no match for X";
 * otherwise text + lark_md `stockTable*` meta consumed by the Feishu
 * adapter for a native rich table.
 *
 * Delegates row formatting to `formatStockTable` + `stockTableMeta*`
 * (existing pure helpers from `stock-meta/domain/format-stock-table`).
 */

import {
  okResult,
  okResultWithMeta,
  type InstructionEnvelope,
  type ResultOf,
} from '@quant/shared';

import {
  formatStockTable,
  stockTableMetaColumns,
  stockTableMetaRows,
} from '../../stock-meta/domain/format-stock-table.js';
import type { ImOutput } from '../be-types.js';

type StockSearchResult = ResultOf<'stock'>;

export function renderStock(envelope: InstructionEnvelope<StockSearchResult>): ImOutput {
  if (!envelope.ok) return { ok: false, error: envelope.error };
  const { query, rows } = envelope.data;
  if (rows.length === 0) return okResult(`no match for "${query}"`);

  const subheader = `stock matches (${String(rows.length)})`;
  const text = `${subheader}\n\n${formatStockTable(rows)}`;
  return okResultWithMeta(text, {
    stockTableColumns: stockTableMetaColumns(),
    stockTableRows: stockTableMetaRows(rows),
    stockTableSubheader: subheader,
  });
}
