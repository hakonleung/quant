/**
 * Pure rendering for the `/usr` instruction — turns a typed `UsrResult`
 * into the legacy `InstructionResult` envelope (text + meta.tableSections)
 * consumed by both the IM adapter (lark_md tables) and the IM-table
 * fallback path.
 *
 * Lives in instruction-center/cells/ because it's a renderer-only
 * concern — separate from the handler so the data layer is auditable
 * against the renderer in isolation (CLAUDE.md §0 of the new
 * InstructionCenter design).
 *
 * All helpers are pure (CLAUDE.md §2.5.1) — no IO, no clock, no
 * side effect — so they're unit-tested without fixtures or mocks.
 */

import {
  formatResult,
  okResultWithMeta,
  type InstructionEnvelope,
  type ResultOf,
  type UsrLedgerAgg,
  type UsrLedgerSnapshot,
} from '@quant/shared';

import type { ImOutput } from '../be-types.js';

type UsrResult = ResultOf<'usr'>;

/** Renderer entry — used by the InstructionCenter cell. */
export function renderUsr(envelope: InstructionEnvelope<UsrResult>): ImOutput {
  if (!envelope.ok) {
    // Round-trip through formatResult so the IM listener's error rendering
    // stays a single code path: `[code] message`.
    return { ok: false, error: envelope.error };
  }
  const { identity, ledger } = envelope.data;
  const identityRows = identityRowsOf(identity);
  const text = [renderKvTable(identityRows), ledgerTextSection(ledger)].join('\n\n');
  const tableSections: Record<string, unknown>[] = [
    identityTableSection(identityRows),
    ...ledgerTableSections(ledger),
  ];
  return okResultWithMeta(text, { tableSections });
}

/** Plain-text rendering used by socket/http callers that want a string. */
export function formatUsrResult(envelope: InstructionEnvelope<UsrResult>): string {
  return formatResult(renderUsr(envelope));
}

// ── identity ───────────────────────────────────────────────────────────

type KvRow = readonly [string, string];

function identityRowsOf(identity: UsrResult['identity']): readonly KvRow[] {
  const rows: KvRow[] = [
    ['user_id', identity.userId],
    ['role', identity.role],
    ['source', identity.source],
  ];
  if (identity.channel !== undefined) rows.push(['channel', identity.channel]);
  if (identity.imId !== undefined) rows.push(['im_id', identity.imId]);
  if (identity.mappedFromUserId !== undefined) {
    rows.push(['mapped_from', `${identity.mappedFromUserId} (AUTH_ADMIN_USER_IDS)`]);
  }
  if (identity.imBootstrap === true) {
    rows.push(['bootstrap', 'true (no Web login yet)']);
  }
  return rows;
}

function identityTableSection(identityRows: readonly KvRow[]): Record<string, unknown> {
  return {
    title: '身份',
    columns: [
      { name: 'k', displayName: 'key', horizontalAlign: 'left', width: '110px' },
      { name: 'v', displayName: 'value', horizontalAlign: 'left' },
    ],
    rows: identityRows.map(([k, v]) => ({ k, v })),
  };
}

// ── ledger ─────────────────────────────────────────────────────────────

function ledgerTextSection(ledger: UsrLedgerSnapshot | null): string {
  if (ledger === null) return '【LLM 使用】\n```\n(no calls yet)\n```';
  const spendRows: readonly (readonly [string, string, string, string])[] = [
    ['scope', 'calls', 'in', 'out'],
    spendRow(ledger.today),
    spendRow(ledger.month),
    spendRow(ledger.total),
  ];
  const out = ['【LLM 使用】', render4ColTable(spendRows)];
  if (ledger.byScope.length > 0) {
    out.push('【按 scope 拆分】', render3ColTable(scopeOrModelRows('scope', ledger.byScope)));
  }
  if (ledger.byModel.length > 0) {
    out.push('【按 model 拆分】', render3ColTable(scopeOrModelRows('model', ledger.byModel)));
  }
  return out.join('\n');
}

function ledgerTableSections(ledger: UsrLedgerSnapshot | null): Record<string, unknown>[] {
  if (ledger === null) {
    return [
      {
        title: 'LLM 使用',
        columns: [{ name: 'note', displayName: '', horizontalAlign: 'left' }],
        rows: [{ note: '(no calls yet)' }],
      },
    ];
  }
  const sections: Record<string, unknown>[] = [
    {
      title: 'LLM 使用',
      columns: [
        { name: 'scope', displayName: 'scope', horizontalAlign: 'left', width: '90px' },
        { name: 'calls', displayName: 'calls', horizontalAlign: 'right', width: '80px' },
        { name: 'in', displayName: 'in', horizontalAlign: 'right', width: '90px' },
        { name: 'out', displayName: 'out', horizontalAlign: 'right', width: '90px' },
      ],
      rows: [
        { scope: 'today', ...spendCells(ledger.today) },
        { scope: 'month', ...spendCells(ledger.month) },
        { scope: 'total', ...spendCells(ledger.total) },
      ],
    },
  ];
  if (ledger.byScope.length > 0) {
    sections.push({
      title: '按 scope 拆分',
      columns: [
        { name: 'scope', displayName: 'scope', horizontalAlign: 'left', width: '160px' },
        { name: 'calls', displayName: 'calls', horizontalAlign: 'right', width: '90px' },
        { name: 'tokens', displayName: 'tokens', horizontalAlign: 'right', width: '110px' },
      ],
      rows: ledger.byScope.map((a) => ({
        scope: a.label,
        calls: String(a.callCount),
        tokens: String(a.total),
      })),
    });
  }
  if (ledger.byModel.length > 0) {
    sections.push({
      title: '按 model 拆分',
      columns: [
        { name: 'model', displayName: 'model', horizontalAlign: 'left', width: '160px' },
        { name: 'calls', displayName: 'calls', horizontalAlign: 'right', width: '90px' },
        { name: 'tokens', displayName: 'tokens', horizontalAlign: 'right', width: '110px' },
      ],
      rows: ledger.byModel.map((a) => ({
        model: a.label,
        calls: String(a.callCount),
        tokens: String(a.total),
      })),
    });
  }
  return sections;
}

function spendRow(agg: UsrLedgerAgg): readonly [string, string, string, string] {
  return [agg.label, String(agg.callCount), String(agg.input), String(agg.output)];
}

function spendCells(agg: UsrLedgerAgg): Record<string, string> {
  return {
    calls: String(agg.callCount),
    in: String(agg.input),
    out: String(agg.output),
  };
}

function scopeOrModelRows(
  header: 'scope' | 'model',
  aggs: readonly UsrLedgerAgg[],
): readonly (readonly [string, string, string])[] {
  return [
    [header, 'calls', 'tokens'],
    ...aggs.map((a) => [a.label, String(a.callCount), String(a.total)] as const),
  ];
}

// ── table-rendering primitives (lark_md-friendly, monospace) ───────────

function renderKvTable(rows: readonly KvRow[]): string {
  const w0 = maxWidth(rows.map((r) => r[0]));
  const w1 = maxWidth(rows.map((r) => r[1]));
  const lines = rows.map(([k, v]) => `${pad(k, w0, 'left')}  ${pad(v, w1, 'left')}`);
  return ['```', ...lines, '```'].join('\n');
}

function render4ColTable(rows: readonly (readonly [string, string, string, string])[]): string {
  const widths: [number, number, number, number] = [
    maxWidth(rows.map((r) => r[0])),
    maxWidth(rows.map((r) => r[1])),
    maxWidth(rows.map((r) => r[2])),
    maxWidth(rows.map((r) => r[3])),
  ];
  const fmt = (r: readonly [string, string, string, string]): string =>
    `${pad(r[0], widths[0], 'left')}  ${pad(r[1], widths[1], 'right')}  ${pad(r[2], widths[2], 'right')}  ${pad(r[3], widths[3], 'right')}`;
  const sep = `${'─'.repeat(widths[0])}  ${'─'.repeat(widths[1])}  ${'─'.repeat(widths[2])}  ${'─'.repeat(widths[3])}`;
  const header = rows[0];
  const body = rows.slice(1);
  if (header === undefined) return '```\n(no data)\n```';
  return ['```', fmt(header), sep, ...body.map(fmt), '```'].join('\n');
}

function render3ColTable(rows: readonly (readonly [string, string, string])[]): string {
  const widths: [number, number, number] = [
    maxWidth(rows.map((r) => r[0])),
    maxWidth(rows.map((r) => r[1])),
    maxWidth(rows.map((r) => r[2])),
  ];
  const fmt = (r: readonly [string, string, string]): string =>
    `${pad(r[0], widths[0], 'left')}  ${pad(r[1], widths[1], 'right')}  ${pad(r[2], widths[2], 'right')}`;
  const sep = `${'─'.repeat(widths[0])}  ${'─'.repeat(widths[1])}  ${'─'.repeat(widths[2])}`;
  const header = rows[0];
  const body = rows.slice(1);
  if (header === undefined) return '```\n(no data)\n```';
  return ['```', fmt(header), sep, ...body.map(fmt), '```'].join('\n');
}

function maxWidth(strs: readonly string[]): number {
  let m = 0;
  for (const s of strs) {
    const w = displayWidth(s);
    if (w > m) m = w;
  }
  return m;
}

function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6)
  );
}

function pad(s: string, target: number, side: 'left' | 'right'): string {
  const w = displayWidth(s);
  if (w >= target) return s;
  const fill = ' '.repeat(target - w);
  return side === 'left' ? s + fill : fill + s;
}
