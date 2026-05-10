/**
 * Pure text-table formatter for IM stock lists.
 *
 * Columns: code · name · price · pct(1d) · 20d% · 90d% · 250d%
 *
 * Output is wrapped in a triple-backtick code fence so Feishu /
 * Slack `lark_md` (and Slack mrkdwn) preserve the column padding.
 * Without the fence, markdown collapses runs of spaces to a single
 * space and the table loses all alignment — IM users see a single
 * blob with the "pct" column squashed against the price column,
 * matching the user's "pct 没显示 / 列没对齐" report.
 *
 * Column widths are computed from the actual cell contents (clamped
 * to a minimum) so Chinese names with full-width characters still
 * line up. East-Asian chars count as 2 display columns.
 */

const COLS = {
  code: { header: 'code', min: 6, align: 'left' as const },
  name: { header: 'name', min: 10, align: 'left' as const },
  price: { header: 'price', min: 8, align: 'right' as const },
  pct: { header: 'pct%', min: 7, align: 'right' as const },
  d20: { header: '20d%', min: 7, align: 'right' as const },
  d90: { header: '90d%', min: 7, align: 'right' as const },
  d250: { header: '250d%', min: 7, align: 'right' as const },
};

export interface StockTableRow {
  readonly code: string;
  readonly name: string;
  readonly price: string | null;
  readonly ret_1d: string | null;
  readonly ret_20d: string | null;
  readonly ret_90d: string | null;
  readonly ret_250d: string | null;
}

/**
 * Convert the same {@link StockTableRow}s into the structured shape the
 * Feishu adapter consumes via `output.meta.stockTableRows` to render a
 * native schema-2.0 `table` element. Pre-formats every numeric cell to a
 * display string so the renderer does no math itself — keeps the column
 * order / header labels in lockstep with the text-table fallback.
 *
 * Slack and the term widget continue to use {@link formatStockTable};
 * Feishu prefers the structured rows when both are present.
 */
export function stockTableMetaRows(
  rows: readonly StockTableRow[],
): ReadonlyArray<Readonly<Record<string, string | null>>> {
  return rows.map((r) => ({
    code: r.code,
    name: r.name,
    price: r.price,
    pct: fmtPctOrNull(r.ret_1d),
    d20: fmtPctOrNull(r.ret_20d),
    d90: fmtPctOrNull(r.ret_90d),
    d250: fmtPctOrNull(r.ret_250d),
  }));
}

function fmtPctOrNull(raw: string | null): string | null {
  if (raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const pct = n * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

export function formatStockTable(rows: readonly StockTableRow[]): string {
  if (rows.length === 0) return '```\n(no data)\n```';
  const cells = rows.map((r) => ({
    code: r.code,
    name: r.name,
    price: r.price ?? '—',
    pct: fmtPct(r.ret_1d),
    d20: fmtPct(r.ret_20d),
    d90: fmtPct(r.ret_90d),
    d250: fmtPct(r.ret_250d),
  }));
  type Key = keyof typeof COLS;
  const widths: Record<Key, number> = {
    code: COLS.code.min,
    name: COLS.name.min,
    price: COLS.price.min,
    pct: COLS.pct.min,
    d20: COLS.d20.min,
    d90: COLS.d90.min,
    d250: COLS.d250.min,
  };
  for (const k of Object.keys(COLS) as Key[]) {
    widths[k] = Math.max(widths[k], displayWidth(COLS[k].header));
    for (const c of cells) widths[k] = Math.max(widths[k], displayWidth(c[k]));
  }
  const headerCells = (Object.keys(COLS) as Key[]).map((k) =>
    pad(COLS[k].header, widths[k], COLS[k].align),
  );
  const headerLine = headerCells.join('  ');
  const separator = (Object.keys(COLS) as Key[]).map((k) => '─'.repeat(widths[k])).join('  ');
  const bodyLines = cells.map((c) =>
    (Object.keys(COLS) as Key[]).map((k) => pad(c[k], widths[k], COLS[k].align)).join('  '),
  );
  return ['```', headerLine, separator, ...bodyLines, '```'].join('\n');
}

function fmtPct(raw: string | null): string {
  if (raw === null || raw === '') return '—';
  const n = Number(raw);
  if (!Number.isFinite(n)) return '—';
  const pct = n * 100;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

/**
 * East-Asian wide chars (most CJK) take ~2 monospace columns. Naive
 * `.padEnd(n)` overshoots/undershoots for Chinese stock names and the
 * columns drift visibly — width-aware padding keeps them aligned.
 */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

function isWide(cp: number): boolean {
  // CJK Unified Ideographs + Hiragana + Katakana + Hangul + CJK Symbols
  // + full-width forms — covers ≈ all chars we'd see in a stock name.
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK Radicals
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana / Katakana / CJK Symbols
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compat
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) || // Full-width forms
    (cp >= 0xffe0 && cp <= 0xffe6)
  );
}

function pad(s: string, target: number, side: 'left' | 'right'): string {
  const w = displayWidth(s);
  if (w >= target) return s;
  const fill = ' '.repeat(target - w);
  return side === 'left' ? s + fill : fill + s;
}
