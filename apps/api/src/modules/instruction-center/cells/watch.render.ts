/**
 * Pure rendering for `/watch` (list). Empty tasks → "no watch tasks".
 * Otherwise emits a task-list subheader; when `stockRows` is non-null,
 * appends the formatted stock table + the `stockTable*` meta keys
 * consumed by the Feishu adapter.
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

type WatchListResult = ResultOf<'watch'>;

export function renderWatch(envelope: InstructionEnvelope<WatchListResult>): ImOutput {
  if (!envelope.ok) return { ok: false, error: envelope.error };
  const { tasks, stockRows } = envelope.data;
  if (tasks.length === 0) return okResult('no watch tasks');

  const metaLines = tasks.map((t) => {
    const wid = `w${String(t.idx)}`.padEnd(4);
    const key = `${t.market}:${t.code}`.padEnd(10);
    const name = t.name.slice(0, 8).padEnd(8);
    const grp = `grp=${t.groupName}`.padEnd(16);
    const status = t.enabled ? 'on ' : 'off';
    return `  ${wid}  ${key}  ${name}  ${grp}  ${status}  hits=${String(t.hitCount)}`;
  });
  const subheader = [`watch tasks (${String(tasks.length)}):`, ...metaLines].join('\n');

  if (stockRows === null || stockRows.length === 0) {
    return okResult(subheader);
  }
  const text = [subheader, '', formatStockTable(stockRows)].join('\n');
  return okResultWithMeta(text, {
    stockTableRows: stockTableMetaRows(stockRows),
    stockTableSubheader: subheader,
  });
}
