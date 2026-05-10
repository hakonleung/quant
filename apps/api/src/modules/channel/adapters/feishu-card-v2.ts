/**
 * Feishu schema-2.0 card builders. Hosts the native `table` content
 * component (Feishu doc:
 * https://open.feishu.cn/document/feishu-cards/card-json-v2-components/content-components/table)
 * and the `meta`-driven dispatcher that upgrades a regular handler
 * reply into a real aligned table card when the handler surfaces
 * `output.meta.stockTableRows`.
 *
 * Why a separate module: the legacy v1 builders in `feishu-card.ts`
 * already fill the file's 400-LoC budget, and v1 / v2 envelopes don't
 * share fields. Splitting keeps each file focused on one card-format
 * generation (CLAUDE.md §1.2 file size + single-responsibility).
 *
 * The `lark_md` / `markdown` body fallback in v1 cards can't align
 * columns because Feishu's web/desktop client renders both with a
 * proportional font and collapses whitespace runs — see the screenshot
 * report 「飞书渲染的 table 布局全是乱的」. The native `table` element
 * in card-kit-v2 is the only Feishu-side widget that lays a real
 * aligned table; this module is the route to it.
 */

import type { FeishuV2Card } from './feishu-card.js';
import { metaString } from './feishu-card.js';

/**
 * Free-form row shape — handlers send `Record<string, string|null>`
 * keyed by the column `name` they declared in `stockTableColumns`.
 * `null` cells render as `—` per Feishu's text-cell default.
 */
export type StockTableMetaRow = Readonly<Record<string, string | null>>;

export interface StockTableMetaColumn {
  /** Stable key — must match a key on each `stockTableRows[i]`. */
  readonly name: string;
  /** Header label shown in the rendered table (defaults to `name`). */
  readonly displayName?: string;
  /** Per-Feishu spec: `'text' | 'lark_md' | 'number' | 'date' | …` */
  readonly dataType?: 'text' | 'lark_md';
  readonly horizontalAlign?: 'left' | 'center' | 'right';
  readonly width?: string;
}

const DEFAULT_STOCK_TABLE_COLUMNS: readonly StockTableMetaColumn[] = [
  { name: 'code', displayName: 'code', horizontalAlign: 'left', width: '90px' },
  { name: 'name', displayName: 'name', horizontalAlign: 'left', width: '120px' },
  { name: 'price', displayName: 'price', horizontalAlign: 'right', width: '90px' },
  { name: 'pct', displayName: 'pct%', horizontalAlign: 'right', width: '80px' },
  { name: 'd20', displayName: '20d%', horizontalAlign: 'right', width: '80px' },
  { name: 'd90', displayName: '90d%', horizontalAlign: 'right', width: '80px' },
  { name: 'd250', displayName: '250d%', horizontalAlign: 'right', width: '80px' },
];

function isScalar(v: unknown): v is string | number {
  return typeof v === 'string' || typeof v === 'number';
}

function metaRows(meta: Readonly<Record<string, unknown>>): readonly StockTableMetaRow[] | null {
  const raw = meta['stockTableRows'];
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: StockTableMetaRow[] = [];
  for (const r of raw) {
    if (typeof r !== 'object' || r === null) continue;
    const row: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(r as Record<string, unknown>)) {
      if (v === null || v === undefined) row[k] = null;
      else if (isScalar(v)) row[k] = String(v);
      // Other types ignored — table renderer expects scalars only.
    }
    out.push(row);
  }
  return out;
}

function readColumn(obj: Readonly<Record<string, unknown>>): StockTableMetaColumn | null {
  const name = obj['name'];
  if (typeof name !== 'string' || name.length === 0) return null;
  // Build with a local mutable shape so `exactOptionalPropertyTypes`
  // doesn't fight optional-field assignment. Single conversion at the
  // return boundary keeps type-safety end-to-end and drops the four
  // narrow-cast workarounds the previous version needed.
  interface MutableColumn {
    name: string;
    displayName?: string;
    dataType?: 'text' | 'lark_md';
    horizontalAlign?: 'left' | 'center' | 'right';
    width?: string;
  }
  const col: MutableColumn = { name };
  const displayName = obj['displayName'];
  if (typeof displayName === 'string') col.displayName = displayName;
  const dataType = obj['dataType'];
  if (dataType === 'text' || dataType === 'lark_md') col.dataType = dataType;
  const align = obj['horizontalAlign'];
  if (align === 'left' || align === 'center' || align === 'right') col.horizontalAlign = align;
  const width = obj['width'];
  if (typeof width === 'string') col.width = width;
  return col;
}

function metaColumns(meta: Readonly<Record<string, unknown>>): readonly StockTableMetaColumn[] {
  const raw = meta['stockTableColumns'];
  if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_STOCK_TABLE_COLUMNS;
  const out: StockTableMetaColumn[] = [];
  for (const c of raw) {
    if (typeof c !== 'object' || c === null) continue;
    const parsed = readColumn(c as Record<string, unknown>);
    if (parsed !== null) out.push(parsed);
  }
  return out.length > 0 ? out : DEFAULT_STOCK_TABLE_COLUMNS;
}

/**
 * Build a schema-2.0 card with a native `table` element for stock lists.
 * `subheaderMd` (the sector/screen meta line above the table) goes into
 * a preceding `markdown` element — short and never tabular, so the
 * existing markdown widget renders it correctly.
 */
function buildStockTableV2Card(args: {
  readonly headerTitle: string;
  readonly headerTemplate: FeishuV2Card['header']['template'];
  readonly subheaderMd: string | null;
  readonly columns: readonly StockTableMetaColumn[];
  readonly rows: readonly StockTableMetaRow[];
}): FeishuV2Card {
  const elements: unknown[] = [];
  if (args.subheaderMd !== null && args.subheaderMd.length > 0) {
    elements.push({ tag: 'markdown', content: args.subheaderMd });
  }
  elements.push({
    tag: 'table',
    page_size: 10,
    row_height: 'low',
    freeze_first_column: true,
    header_style: { background_style: 'grey', bold: true, text_align: 'left' },
    columns: args.columns.map((c) => ({
      name: c.name,
      display_name: c.displayName ?? c.name,
      data_type: c.dataType ?? 'text',
      ...(c.horizontalAlign !== undefined ? { horizontal_align: c.horizontalAlign } : {}),
      ...(c.width !== undefined ? { width: c.width } : {}),
    })),
    rows: args.rows.map((r) => {
      const out: Record<string, string> = {};
      for (const col of args.columns) {
        const v = r[col.name];
        out[col.name] = v === null || v === undefined ? '—' : v;
      }
      return out;
    }),
  });
  return {
    schema: '2.0',
    header: {
      template: args.headerTemplate,
      title: { tag: 'plain_text', content: args.headerTitle },
    },
    body: { elements },
  };
}

/**
 * If the outbound carries handler-side `stockTableRows`, render a
 * schema-2.0 native-table card. Centralised so every `instruction.reply`
 * and `instruction.async.completed` flow gets the same upgrade
 * automatically — handlers just need to set the meta fields.
 *
 * `text` is the legacy ASCII body the handler also produces (for term /
 * Slack fallbacks); we strip the table portion off it (everything after
 * the first blank line) and use only the subheader line.
 */
export function maybeStockTableCard(
  text: string,
  meta: Readonly<Record<string, unknown>>,
  defaults: {
    readonly headerTitle: string;
    readonly headerTemplate: FeishuV2Card['header']['template'];
  },
): FeishuV2Card | null {
  const rows = metaRows(meta);
  if (rows === null) return null;
  const columns = metaColumns(meta);
  const explicit = metaString(meta, 'stockTableSubheader');
  const fallback = explicit ?? (text.split('\n\n')[0]?.trim() ?? '');
  return buildStockTableV2Card({
    headerTitle: defaults.headerTitle,
    headerTemplate: defaults.headerTemplate,
    subheaderMd: fallback.length > 0 ? fallback : null,
    columns,
    rows,
  });
}

// ── generic multi-table card ─────────────────────────────────────────────
//
// Generalised version of the stock-table renderer for handlers that want
// one or more native Feishu tables in a single reply (help, usr, sector
// list, stock search, ledger). Handlers attach
// `meta.tableSections: { title?, columns, rows }[]` and the dispatcher
// emits a schema-2.0 card with a `markdown` title above each table.

export interface MetaTableSection {
  readonly title?: string;
  readonly columns: readonly StockTableMetaColumn[];
  readonly rows: readonly StockTableMetaRow[];
}

function isPlainObject(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === 'object' && v !== null;
}

function parseSectionColumns(raw: readonly unknown[]): StockTableMetaColumn[] {
  const columns: StockTableMetaColumn[] = [];
  for (const c of raw) {
    if (!isPlainObject(c)) continue;
    const parsed = readColumn(c);
    if (parsed !== null) columns.push(parsed);
  }
  return columns;
}

function parseSectionRows(raw: readonly unknown[]): StockTableMetaRow[] {
  const rows: StockTableMetaRow[] = [];
  for (const r of raw) {
    if (!isPlainObject(r)) continue;
    const row: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(r)) {
      if (v === null || v === undefined) row[k] = null;
      else if (isScalar(v)) row[k] = String(v);
    }
    rows.push(row);
  }
  return rows;
}

function readSection(obj: Readonly<Record<string, unknown>>): MetaTableSection | null {
  const rawCols = obj['columns'];
  const rawRows = obj['rows'];
  if (!Array.isArray(rawCols) || !Array.isArray(rawRows)) return null;
  const columns = parseSectionColumns(rawCols);
  if (columns.length === 0) return null;
  const rows = parseSectionRows(rawRows);
  const title = obj['title'];
  return typeof title === 'string' && title.length > 0
    ? { title, columns, rows }
    : { columns, rows };
}

function metaSections(meta: Readonly<Record<string, unknown>>): readonly MetaTableSection[] | null {
  const raw = meta['tableSections'];
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: MetaTableSection[] = [];
  for (const item of raw) {
    if (!isPlainObject(item)) continue;
    const parsed = readSection(item);
    if (parsed !== null) out.push(parsed);
  }
  return out.length > 0 ? out : null;
}

function tableElement(section: MetaTableSection): unknown {
  return {
    tag: 'table',
    page_size: 10,
    row_height: 'low',
    freeze_first_column: true,
    header_style: { background_style: 'grey', bold: true, text_align: 'left' },
    columns: section.columns.map((c) => ({
      name: c.name,
      display_name: c.displayName ?? c.name,
      data_type: c.dataType ?? 'text',
      ...(c.horizontalAlign !== undefined ? { horizontal_align: c.horizontalAlign } : {}),
      ...(c.width !== undefined ? { width: c.width } : {}),
    })),
    rows: section.rows.map((r) => {
      const out: Record<string, string> = {};
      for (const col of section.columns) {
        out[col.name] = r[col.name] ?? '—';
      }
      return out;
    }),
  };
}

/**
 * Multi-table sibling of {@link maybeStockTableCard}. When the handler
 * surfaces `meta.tableSections`, render a schema-2.0 card with one
 * `table` element per section (preceded by a `markdown` title element
 * when the section has one). An optional `meta.tablesSubheader` adds a
 * single markdown line at the top of the card.
 */
export function maybeMetaTablesCard(
  meta: Readonly<Record<string, unknown>>,
  defaults: {
    readonly headerTitle: string;
    readonly headerTemplate: FeishuV2Card['header']['template'];
  },
): FeishuV2Card | null {
  const sections = metaSections(meta);
  if (sections === null) return null;
  const elements: unknown[] = [];
  const subheader = metaString(meta, 'tablesSubheader');
  if (subheader !== null) elements.push({ tag: 'markdown', content: subheader });
  for (const section of sections) {
    if (section.title !== undefined && section.title.length > 0) {
      elements.push({ tag: 'markdown', content: `**${section.title}**` });
    }
    elements.push(tableElement(section));
  }
  return {
    schema: '2.0',
    header: {
      template: defaults.headerTemplate,
      title: { tag: 'plain_text', content: defaults.headerTitle },
    },
    body: { elements },
  };
}
