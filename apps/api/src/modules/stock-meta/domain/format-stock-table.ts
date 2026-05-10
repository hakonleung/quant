/**
 * Pure formatter for IM stock-list tables.
 *
 * Aligned with the frontend EQ.LIST default columns
 * (apps/web/lib/eqty/columns.catalog.ts §defaultApplied):
 *   code · name · price · chg% · 换手 · 成交额 · 连涨 · 5d% · 20d% · 90d% · 250d%
 *
 * For dynamic sectors the caller appends extra "evidence" columns
 * keyed by the sector's evaluator output (e.g. `vol_ratio`, `streak`),
 * matching FE's per-row evidence rendering. Numeric evidence values are
 * formatted by the caller; this module only handles the well-known
 * built-in columns.
 *
 * Two outputs:
 *   - {@link formatStockTable}: monospace ASCII table for term / Slack.
 *   - {@link stockTableMetaRows} + {@link stockTableMetaColumns}:
 *     structured row + column descriptors handed to the Feishu
 *     schema-2.0 native `table` widget via `output.meta.tableSections`.
 */

const PCT_COL_KEYS = ['chgPct', 'turnoverRate', 'ret5d', 'ret20d', 'ret90d', 'ret250d'] as const;

/**
 * Built-in column order — must match the FE default applied set so the
 * IM card and the web mkt list line up. Keep this in lockstep with
 * `apps/web/lib/eqty/columns.catalog.ts`.
 */
const BUILTIN_COLUMNS = [
  { key: 'code', header: 'code', align: 'left' as const, width: 90, min: 6 },
  { key: 'name', header: 'name', align: 'left' as const, width: 120, min: 10 },
  { key: 'price', header: 'price', align: 'right' as const, width: 80, min: 8 },
  { key: 'chgPct', header: 'chg%', align: 'right' as const, width: 80, min: 7 },
  { key: 'turnoverRate', header: '换手', align: 'right' as const, width: 80, min: 6 },
  { key: 'turnover', header: '成交额', align: 'right' as const, width: 100, min: 10 },
  { key: 'consecUp', header: '连涨', align: 'right' as const, width: 80, min: 6 },
  { key: 'ret5d', header: '5d%', align: 'right' as const, width: 80, min: 7 },
  { key: 'ret20d', header: '20d%', align: 'right' as const, width: 80, min: 7 },
  { key: 'ret90d', header: '90d%', align: 'right' as const, width: 80, min: 7 },
  { key: 'ret250d', header: '250d%', align: 'right' as const, width: 80, min: 7 },
] as const;

type BuiltinKey = (typeof BUILTIN_COLUMNS)[number]['key'];

/**
 * Build a {@link StockTableRow} from the snapshot DTO. Centralises the
 * "fields the snapshot endpoint doesn't carry → null" mapping so every
 * IM handler that joins snapshot data onto a stock list (sector.show,
 * screen, watch) ends up with the exact same shape — and a uniform
 * `—` rendering for kline-only metrics.
 */
interface SnapshotForRow {
  readonly price: string | null;
  readonly returns: {
    readonly ret_1d: string | null;
    readonly ret_5d: string | null;
    readonly ret_20d: string | null;
    readonly ret_90d: string | null;
    readonly ret_250d: string | null;
  };
}

export function rowFromSnapshot(args: {
  readonly code: string;
  readonly name: string;
  readonly snapshot: SnapshotForRow | undefined;
  readonly evidence?: Readonly<Record<string, string | null>>;
}): StockTableRow {
  const fields = snapshotFields(args.snapshot);
  return {
    code: args.code,
    name: args.name,
    ...fields,
    ...(args.evidence !== undefined ? { evidence: args.evidence } : {}),
  };
}

function snapshotFields(snap: SnapshotForRow | undefined): Omit<StockTableRow, 'code' | 'name'> {
  if (snap === undefined) {
    return {
      price: null,
      chgPct: null,
      turnoverRate: null,
      turnover: null,
      consecUpDays: null,
      ret5d: null,
      ret20d: null,
      ret90d: null,
      ret250d: null,
    };
  }
  return {
    price: snap.price,
    chgPct: snap.returns.ret_1d,
    turnoverRate: null,
    turnover: null,
    consecUpDays: null,
    ret5d: snap.returns.ret_5d,
    ret20d: snap.returns.ret_20d,
    ret90d: snap.returns.ret_90d,
    ret250d: snap.returns.ret_250d,
  };
}

export interface StockTableRow {
  readonly code: string;
  readonly name: string;
  readonly price: string | null;
  readonly chgPct: string | null;
  readonly turnoverRate: string | null;
  readonly turnover: string | null;
  readonly consecUpDays: number | null;
  readonly ret5d: string | null;
  readonly ret20d: string | null;
  readonly ret90d: string | null;
  readonly ret250d: string | null;
  /**
   * Dynamic-sector evidence cells, pre-formatted for display
   * (`fmtPct` / `fmtCny` / etc. — caller's choice). Keys become column
   * names and headers; column order follows the iteration order of the
   * Map / object.
   */
  readonly evidence?: Readonly<Record<string, string | null>>;
}

export interface StockTableColumnMeta {
  readonly name: string;
  readonly displayName: string;
  readonly horizontalAlign: 'left' | 'center' | 'right';
  readonly width?: string;
}

/**
 * Build the column descriptors for the Feishu schema-2.0 native table.
 * Always emits the built-in columns; appends one descriptor per evidence
 * key when the dynamic sector surfaced any.
 */
export function stockTableMetaColumns(
  evidenceKeys: readonly string[] = [],
): readonly StockTableColumnMeta[] {
  const builtins: StockTableColumnMeta[] = BUILTIN_COLUMNS.map((c) => ({
    name: c.key,
    displayName: c.header,
    horizontalAlign: c.align,
    width: `${String(c.width)}px`,
  }));
  const evidence: StockTableColumnMeta[] = evidenceKeys.map((k) => ({
    name: `ev_${k}`,
    displayName: k.toUpperCase(),
    horizontalAlign: 'right',
    width: '100px',
  }));
  return [...builtins, ...evidence];
}

/**
 * Convert {@link StockTableRow}s into the structured row shape consumed
 * by the Feishu adapter through `output.meta.tableSections`. Pre-formats
 * every numeric cell to a display string so the renderer does no math
 * itself — keeps the column order / header labels in lockstep with the
 * text-table fallback.
 */
export function stockTableMetaRows(
  rows: readonly StockTableRow[],
  evidenceKeys: readonly string[] = [],
): readonly Readonly<Record<string, string | null>>[] {
  return rows.map((r) => {
    const out: Record<string, string | null> = {
      code: r.code,
      name: r.name,
      price: r.price,
      chgPct: fmtPctOrNull(r.chgPct),
      turnoverRate: fmtPctOrNull(r.turnoverRate),
      turnover: fmtCnyOrNull(r.turnover),
      consecUp: r.consecUpDays === null ? null : `${String(r.consecUpDays)}d`,
      ret5d: fmtPctOrNull(r.ret5d),
      ret20d: fmtPctOrNull(r.ret20d),
      ret90d: fmtPctOrNull(r.ret90d),
      ret250d: fmtPctOrNull(r.ret250d),
    };
    const ev = r.evidence ?? {};
    for (const k of evidenceKeys) {
      out[`ev_${k}`] = ev[k] ?? null;
    }
    return out;
  });
}

function fmtPctOrNull(raw: string | null): string | null {
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const pct = n * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

function fmtCnyOrNull(raw: string | null): string | null {
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(2)}亿`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e4).toFixed(2)}万`;
  return n.toFixed(2);
}

/** ASCII fallback rendered for term / Slack. Built-in columns only. */
export function formatStockTable(rows: readonly StockTableRow[]): string {
  if (rows.length === 0) return '```\n(no data)\n```';
  const cells = rows.map((r) => ({
    code: r.code,
    name: r.name,
    price: r.price ?? '—',
    chgPct: fmtPctOrNull(r.chgPct) ?? '—',
    turnoverRate: fmtPctOrNull(r.turnoverRate) ?? '—',
    turnover: fmtCnyOrNull(r.turnover) ?? '—',
    consecUp: r.consecUpDays === null ? '—' : `${String(r.consecUpDays)}d`,
    ret5d: fmtPctOrNull(r.ret5d) ?? '—',
    ret20d: fmtPctOrNull(r.ret20d) ?? '—',
    ret90d: fmtPctOrNull(r.ret90d) ?? '—',
    ret250d: fmtPctOrNull(r.ret250d) ?? '—',
  })) satisfies readonly Record<BuiltinKey, string>[];

  const widths: Record<BuiltinKey, number> = {
    code: 0,
    name: 0,
    price: 0,
    chgPct: 0,
    turnoverRate: 0,
    turnover: 0,
    consecUp: 0,
    ret5d: 0,
    ret20d: 0,
    ret90d: 0,
    ret250d: 0,
  };
  for (const c of BUILTIN_COLUMNS) widths[c.key] = c.min;
  for (const c of BUILTIN_COLUMNS) {
    widths[c.key] = Math.max(widths[c.key], displayWidth(c.header));
  }
  for (const row of cells) {
    for (const c of BUILTIN_COLUMNS) {
      const w = displayWidth(row[c.key]);
      if (w > widths[c.key]) widths[c.key] = w;
    }
  }
  const headerLine = BUILTIN_COLUMNS.map((c) => pad(c.header, widths[c.key], c.align)).join('  ');
  const separator = BUILTIN_COLUMNS.map((c) => '─'.repeat(widths[c.key])).join('  ');
  const bodyLines = cells.map((c) =>
    BUILTIN_COLUMNS.map((col) => pad(c[col.key], widths[col.key], col.align)).join('  '),
  );
  return ['```', headerLine, separator, ...bodyLines, '```'].join('\n');
}

// Suppress "value never read" — PCT_COL_KEYS is exported elsewhere too.
void PCT_COL_KEYS;

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
