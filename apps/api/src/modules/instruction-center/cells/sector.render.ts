/**
 * Pure rendering for `/sector` (list). Turns a typed `SectorListResult`
 * into the legacy `InstructionResult` envelope consumed by the IM
 * adapter (lark_md table) and the term fallback (formatted text).
 *
 * Empty-result path returns `okResult('no sectors visible')` to match
 * the previous `SectorInstructionHandler` behaviour.
 */

import {
  okResult,
  okResultWithMeta,
  type InstructionEnvelope,
  type ResultOf,
} from '@quant/shared';

import type { ImOutput } from '../be-types.js';

type SectorListResult = ResultOf<'sector'>;

export function renderSector(envelope: InstructionEnvelope<SectorListResult>): ImOutput {
  if (!envelope.ok) return { ok: false, error: envelope.error };
  const { rows } = envelope.data;
  if (rows.length === 0) return okResult('no sectors visible');

  const headerLine = `sectors (${String(rows.length)}):`;
  const body = rows
    .map(
      (s) =>
        `  ${s.published ? '[PUB]' : '     '} ${s.id.padEnd(20)}  ${s.name.padEnd(16)}  ${String(s.codeCount).padStart(4)}  by ${s.isOwn ? 'me' : s.createdBy}`,
    )
    .join('\n');
  const text = `${headerLine}\n${body}`;

  return okResultWithMeta(text, {
    tableSections: [
      {
        columns: [
          // Feishu v2 table widths must be ≥ 80px (and ≤ 600px).
          { name: 'pub', displayName: 'pub', horizontalAlign: 'center', width: '80px' },
          { name: 'id', displayName: 'id', horizontalAlign: 'left', width: '90px' },
          { name: 'name', displayName: 'name', horizontalAlign: 'left', width: '160px' },
          { name: 'count', displayName: 'n', horizontalAlign: 'right', width: '80px' },
          { name: 'by', displayName: 'by', horizontalAlign: 'left', width: '120px' },
        ],
        rows: rows.map((s) => ({
          pub: s.published ? '✓' : '',
          id: s.id,
          name: s.name,
          count: String(s.codeCount),
          by: s.isOwn ? 'me' : s.createdBy,
        })),
      },
    ],
    tablesSubheader: `sectors (${String(rows.length)})`,
  });
}
