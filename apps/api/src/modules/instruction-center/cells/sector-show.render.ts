/**
 * Pure rendering for `/sector.show`. Header line + sliced stock table
 * (with evidence columns for dynamic sectors). Output matches legacy
 * `SectorShowInstructionHandler` exactly.
 *
 * `stockRows = null` triggers the fallback path (comma-joined code
 * list) preserving the legacy graceful degradation behaviour.
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

type SectorShowResult = ResultOf<'sector.show'>;

export function renderSectorShow(envelope: InstructionEnvelope<SectorShowResult>): ImOutput {
  if (!envelope.ok) return { ok: false, error: envelope.error };
  const r = envelope.data;
  const headerLine = [
    `${r.id}  ${r.name}  [${r.kind}]`,
    `by ${r.isOwn ? 'me' : r.createdBy}`,
    r.published ? '[PUB]' : '',
    `count=${String(r.totalCount)}`,
  ]
    .filter(Boolean)
    .join('  ');

  const tail =
    r.totalCount > r.codes.length ? `\n(+${String(r.totalCount - r.codes.length)} more)` : '';

  if (r.stockRows === null) {
    return okResult(`${headerLine}\n\n${r.codes.join(', ')}${tail}`);
  }
  const text = `${headerLine}\n\n${formatStockTable(r.stockRows)}${tail}`;
  return okResultWithMeta(text, {
    stockTableColumns: stockTableMetaColumns(r.evidenceKeys),
    stockTableRows: stockTableMetaRows(r.stockRows, r.evidenceKeys),
    stockTableSubheader: `${headerLine}${tail.length > 0 ? `  ·  ${tail.trim()}` : ''}`,
  });
}
