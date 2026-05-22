/**
 * IM stock-list table renderer. Consumes the canonical `StockListRow`
 * DTO from `@quant/shared`, so the Feishu/xterm output and the FE list
 * pane render the exact same column set + order. Evidence columns are
 * appended verbatim (caller pre-formats values).
 *
 * Two outputs:
 *   - {@link formatStockTable}: monospace ASCII table for term / Slack.
 *   - {@link stockTableMetaRows} + {@link stockTableMetaColumns}:
 *     structured row + column descriptors handed to the Feishu
 *     schema-2.0 native `table` widget via `output.meta.tableSections`.
 */

import {
  STOCK_LIST_COLUMN_CATALOG,
  type StockListColumnKey,
  type StockListRow,
} from '@quant/shared';

interface RenderColumn {
  readonly key: 'code' | StockListColumnKey;
  readonly header: string;
  readonly align: 'left' | 'right';
  readonly width: number;
  readonly min: number;
}

const HEADER_OVERRIDES: Partial<Record<StockListColumnKey, string>> = {
  name: 'code',
  price: 'price',
  chgPct: 'chg%',
  turnoverRate: '换手',
  turnover: '成交额',
  consecUp: '连涨',
  ret5d: '5d%',
  ret10d: '10d%',
  ret20d: '20d%',
  ret90d: '90d%',
  ret250d: '250d%',
  wcmi: 'wcmi',
  ddeMainInflow3d: '3d净流入',
  ddeMainInflow5d: '5d净流入',
  ddeMainInflow10d: '10d净流入',
  ddeMainInflow20d: '20d净流入',
  ddeMainInflowRatio3d: '3d占比',
  ddeMainInflowRatio5d: '5d占比',
  ddeMainInflowRatio10d: '10d占比',
  ddeMainInflowRatio20d: '20d占比',
};

const COLUMN_DEFAULTS: Readonly<
  Record<StockListColumnKey, { align: 'left' | 'right'; width: number; min: number }>
> = {
  name: { align: 'left', width: 90, min: 6 },
  price: { align: 'right', width: 80, min: 8 },
  chgPct: { align: 'right', width: 80, min: 7 },
  turnoverRate: { align: 'right', width: 80, min: 6 },
  turnover: { align: 'right', width: 100, min: 10 },
  consecUp: { align: 'right', width: 80, min: 6 },
  ret5d: { align: 'right', width: 80, min: 7 },
  ret10d: { align: 'right', width: 80, min: 7 },
  ret20d: { align: 'right', width: 80, min: 7 },
  ret90d: { align: 'right', width: 80, min: 7 },
  ret250d: { align: 'right', width: 80, min: 7 },
  wcmi: { align: 'right', width: 80, min: 7 },
  wcmiRhythm: { align: 'right', width: 80, min: 7 },
  wcmiMaSupport: { align: 'right', width: 80, min: 7 },
  wcmiUpWave: { align: 'right', width: 80, min: 7 },
  wcmiYangDom: { align: 'right', width: 80, min: 7 },
  wcmiShadowClean: { align: 'right', width: 80, min: 7 },
  wcmiStageGain: { align: 'right', width: 80, min: 7 },
  wcmiCrashAvoid: { align: 'right', width: 80, min: 7 },
  mktCap: { align: 'right', width: 100, min: 10 },
  floatMktCap: { align: 'right', width: 100, min: 10 },
  peTtm: { align: 'right', width: 80, min: 7 },
  peDynamic: { align: 'right', width: 80, min: 7 },
  pb: { align: 'right', width: 70, min: 6 },
  peg: { align: 'right', width: 70, min: 6 },
  grossMargin: { align: 'right', width: 80, min: 7 },
  ddeMainInflow3d: { align: 'right', width: 100, min: 9 },
  ddeMainInflow5d: { align: 'right', width: 100, min: 9 },
  ddeMainInflow10d: { align: 'right', width: 100, min: 9 },
  ddeMainInflow20d: { align: 'right', width: 100, min: 9 },
  ddeMainInflowRatio3d: { align: 'right', width: 80, min: 7 },
  ddeMainInflowRatio5d: { align: 'right', width: 80, min: 7 },
  ddeMainInflowRatio10d: { align: 'right', width: 80, min: 7 },
  ddeMainInflowRatio20d: { align: 'right', width: 80, min: 7 },
};

/** The default column set rendered by IM tables — drops the 6 derived/snapshot
 * fundamentals to keep the row width manageable inside Feishu/xterm. */
const DEFAULT_IM_COLUMNS: readonly StockListColumnKey[] = STOCK_LIST_COLUMN_CATALOG.filter(
  (c) => c.group === 'core' || ['ret5d', 'ret20d', 'ret90d', 'ret250d'].includes(c.key),
).map((c) => c.key);

function buildRenderColumns(columns: readonly StockListColumnKey[]): readonly RenderColumn[] {
  // The leading separate `code` column comes from `StockListRow.code`;
  // `name` from the shared catalog renders the human-readable name.
  // Always show code first so users can map back to a ticker.
  const out: RenderColumn[] = [{ key: 'code', header: 'code', align: 'left', width: 90, min: 6 }];
  for (const key of columns) {
    const defaults = COLUMN_DEFAULTS[key];
    const header = HEADER_OVERRIDES[key] ?? key;
    out.push({
      key,
      header: key === 'name' ? 'name' : header,
      align: defaults.align,
      width: defaults.width,
      min: defaults.min,
    });
  }
  return out;
}

export interface StockTableColumnMeta {
  readonly name: string;
  readonly displayName: string;
  readonly horizontalAlign: 'left' | 'center' | 'right';
  readonly width?: string;
}

/**
 * Build the column descriptors for the Feishu schema-2.0 native table.
 * Always emits the leading `code` column + the supplied applied
 * columns; appends one descriptor per evidence key.
 */
export function stockTableMetaColumns(
  evidenceKeys: readonly string[] = [],
  columns: readonly StockListColumnKey[] = DEFAULT_IM_COLUMNS,
): readonly StockTableColumnMeta[] {
  const render = buildRenderColumns(columns);
  const builtins: StockTableColumnMeta[] = render.map((c) => ({
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
 * Convert {@link StockListRow}s into the structured row shape consumed
 * by the Feishu adapter through `output.meta.tableSections`. Pre-formats
 * every numeric cell to a display string so the renderer does no math
 * itself.
 */
export function stockTableMetaRows(
  rows: readonly StockListRow[],
  evidenceKeys: readonly string[] = [],
  columns: readonly StockListColumnKey[] = DEFAULT_IM_COLUMNS,
): readonly Readonly<Record<string, string | null>>[] {
  return rows.map((r) => {
    const out: Record<string, string | null> = { code: r.code };
    for (const col of columns) out[col] = formatCell(r, col);
    const ev = r.evidence ?? {};
    for (const k of evidenceKeys) {
      out[`ev_${k}`] = ev[k] ?? null;
    }
    return out;
  });
}

/** ASCII fallback rendered for term / Slack. */
export function formatStockTable(
  rows: readonly StockListRow[],
  columns: readonly StockListColumnKey[] = DEFAULT_IM_COLUMNS,
): string {
  if (rows.length === 0) return '```\n(no data)\n```';
  const render = buildRenderColumns(columns);
  const cells = rows.map((r) => {
    const cell: Record<string, string> = { code: r.code };
    for (const col of columns) cell[col] = formatCell(r, col) ?? '—';
    return cell;
  });
  const widths = new Map<string, number>();
  for (const c of render) widths.set(c.key, Math.max(c.min, displayWidth(c.header)));
  for (const row of cells) {
    for (const c of render) {
      const w = displayWidth(row[c.key] ?? '');
      const cur = widths.get(c.key) ?? 0;
      if (w > cur) widths.set(c.key, w);
    }
  }
  const headerLine = render
    .map((c) => pad(c.header, widths.get(c.key) ?? c.min, c.align))
    .join('  ');
  const separator = render.map((c) => '─'.repeat(widths.get(c.key) ?? c.min)).join('  ');
  const bodyLines = cells.map((c) =>
    render
      .map((col) => pad(c[col.key] ?? '', widths.get(col.key) ?? col.min, col.align))
      .join('  '),
  );
  return ['```', headerLine, separator, ...bodyLines, '```'].join('\n');
}

function formatCell(row: StockListRow, col: StockListColumnKey): string | null {
  const v = (row as unknown as Record<string, unknown>)[col];
  if (v === null || v === undefined) return null;
  switch (col) {
    case 'name':
      return typeof v === 'string' ? v : String(v);
    case 'consecUp':
      return typeof v === 'number' ? `${String(v)}d` : null;
    case 'price':
      return typeof v === 'number' ? v.toFixed(2) : null;
    case 'chgPct':
    case 'turnoverRate':
    case 'ret5d':
    case 'ret10d':
    case 'ret20d':
    case 'ret90d':
    case 'ret250d':
    case 'wcmi':
    case 'grossMargin':
    case 'ddeMainInflowRatio3d':
    case 'ddeMainInflowRatio5d':
    case 'ddeMainInflowRatio10d':
    case 'ddeMainInflowRatio20d':
      return typeof v === 'number' ? formatPct(v) : null;
    case 'turnover':
    case 'mktCap':
    case 'floatMktCap':
      return typeof v === 'number' ? formatCny(v) : null;
    case 'ddeMainInflow3d':
    case 'ddeMainInflow5d':
    case 'ddeMainInflow10d':
    case 'ddeMainInflow20d':
      return typeof v === 'number' ? formatCnyDelta(v) : null;
    case 'peTtm':
    case 'peDynamic':
    case 'pb':
    case 'peg':
      return typeof v === 'number' ? v.toFixed(2) : null;
    case 'wcmiRhythm':
    case 'wcmiMaSupport':
    case 'wcmiUpWave':
    case 'wcmiYangDom':
    case 'wcmiShadowClean':
    case 'wcmiStageGain':
    case 'wcmiCrashAvoid':
      // Sub-score percentile already scaled to [0, 100]; render as
      // a plain integer so columns line up at width 4.
      return typeof v === 'number' ? v.toFixed(0) : null;
  }
}

function formatPct(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const pct = n * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

function formatCny(n: number): string {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(2)}亿`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e4).toFixed(2)}万`;
  return n.toFixed(2);
}

/**
 * CNY amount with explicit sign — for DDE net inflow columns where the
 * sign carries information (+ inflow / − outflow). Negative values keep
 * the natural `-`; non-negative values are prefixed with `+` (zero gets
 * `+0` to avoid the visual confusion of bare `0` alongside signed peers).
 */
function formatCnyDelta(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const sign = n >= 0 ? '+' : '-';
  const abs = Math.abs(n);
  if (abs >= 1e8) return `${sign}${(abs / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${sign}${(abs / 1e4).toFixed(2)}万`;
  return `${sign}${abs.toFixed(2)}`;
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

export { DEFAULT_IM_COLUMNS };
