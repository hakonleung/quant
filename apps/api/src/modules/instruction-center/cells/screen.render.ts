/**
 * Pure rendering for `/screen` (NL stock screen).
 *
 * Empty matches → head + "(no matches)".
 * Otherwise:
 *   - `stockRows` non-null → text + lark_md table meta
 *   - `stockRows` null     → text + comma-joined code list (graceful
 *                            fallback when StockListService failed)
 *
 * `displayedCount` is the slice the renderer actually shows; if the
 * total exceeds the cap, a "(+N more)" tail is appended.
 */

import {
  okResult,
  okResultWithMeta,
  type InstructionEnvelope,
  type ResultOf,
} from '@quant/shared';

import {
  formatStockTable,
  stockTableMetaRows,
} from '../../stock-meta/domain/format-stock-table.js';
import type { ImOutput } from '../be-types.js';

type ScreenResult = ResultOf<'screen'>;

export function renderScreen(envelope: InstructionEnvelope<ScreenResult>): ImOutput {
  if (!envelope.ok) return { ok: false, error: envelope.error };
  const r = envelope.data;
  const head = `screen "${r.nl}" asof=${r.asof}  matches=${String(r.totalMatches)}`;
  if (r.totalMatches === 0) {
    return okResult(`${head}\n  (no matches)`);
  }
  const moreTail =
    r.totalMatches > r.displayedCount
      ? `\n(+${String(r.totalMatches - r.displayedCount)} more)`
      : '';
  if (r.stockRows === null) {
    return okResult(`${head}\n\n${r.codes.join(', ')}${moreTail}`);
  }
  const text = `${head}\n\n${formatStockTable(r.stockRows)}${moreTail}`;
  return okResultWithMeta(text, {
    stockTableRows: stockTableMetaRows(r.stockRows),
    stockTableSubheader: `${head}${moreTail.length > 0 ? `  ·  ${moreTail.trim()}` : ''}`,
  });
}
