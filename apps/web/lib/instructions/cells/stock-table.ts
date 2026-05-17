/**
 * Shared "stock table mode" helper for terminal cells.
 *
 * Renders a `StockListRow[]` as an interactive `selectableList` widget
 * with the same default columns the MKT / EQ.LIST pane shows in normal
 * mode (CODE / PRICE / CHG% / 换手 / 成交额 / 连涨). Dynamic-sector
 * evidence keys append as extra right-aligned columns.
 *
 * Both `/sector.show <id>` and `/stock <query>` go through here, so
 * the table reads identically across surfaces. Enter on a row commits
 * to `stock.info <code>`; `a` and `f` shortcuts route to /analyze and
 * /focus respectively, mirroring the picker's behaviour.
 *
 * Pure module — no IO, no globals.
 */

import type { StockListRow } from '@quant/shared';
import {
  interactive,
  selectableList,
  type ColumnSpec,
} from '@quant/terminal';

import {
  fmtChgPct,
  fmtCny,
  fmtConsecUp,
  fmtPct,
  fmtPrice,
} from '../../fp/stock-list-fmt.js';

/**
 * Row passed to the widget. Pre-formatted columns live on the same
 * object so each `ColumnSpec` uses a unique `key` and no `format`
 * callback — keeps `renderTable`'s code path simple and avoids
 * duplicate-key surprises.
 */
export interface StockTableItem extends Record<string, unknown> {
  readonly code: string;
  readonly name: string;
  readonly price: string;
  readonly chgPct: string;
  readonly turnoverRate: string;
  readonly turnover: string;
  readonly consecUp: string;
}

export interface StockTableOptions {
  readonly title: string;
  readonly rows: readonly StockListRow[];
  /** Dynamic-sector evidence column keys; rendered after the core columns. */
  readonly evidenceKeys?: readonly string[];
  /** `{ code: { evKey: pre-formatted string } }` from sector.show payload. */
  readonly evidenceByCode?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** Optional override for the Enter action. Defaults to `stock.info <code>`. */
  readonly onCommitLine?: (item: StockTableItem) => string;
}

const EV_PREFIX = 'ev_';

/**
 * Build the interactive stock-table widget. Returns the engine
 * envelope `{ kind: 'interactive', widget }` ready for a cell renderer
 * to return directly.
 */
export function buildStockTable(opts: StockTableOptions): {
  readonly kind: 'interactive';
  readonly widget: ReturnType<typeof selectableList<StockTableItem>>;
} {
  const evidenceKeys = opts.evidenceKeys ?? [];
  const evidenceByCode = opts.evidenceByCode ?? {};
  const onCommitLine = opts.onCommitLine ?? ((it) => `stock.info ${it.code}`);

  const items: StockTableItem[] = opts.rows.map((row) => {
    const ev = evidenceByCode[row.code] ?? {};
    const base: Record<string, unknown> = {
      code: row.code,
      name: row.name ?? row.code,
      price: fmtPrice(row.price),
      chgPct: fmtChgPct(row.chgPct, true),
      turnoverRate: fmtPct(row.turnoverRate),
      turnover: fmtCny(row.turnover),
      consecUp: fmtConsecUp(row.consecUp),
    };
    for (const k of evidenceKeys) base[`${EV_PREFIX}${k}`] = ev[k] ?? '';
    return base as StockTableItem;
  });

  const columns: ColumnSpec<StockTableItem>[] = [
    { key: 'name', header: 'CODE', align: 'left', max: 16 },
    { key: 'code', header: '代码', align: 'left', max: 8 },
    { key: 'price', header: 'PRICE', align: 'right', max: 9 },
    { key: 'chgPct', header: 'CHG%', align: 'right', max: 9 },
    { key: 'turnoverRate', header: '换手', align: 'right', max: 8 },
    { key: 'turnover', header: '成交额', align: 'right', max: 10 },
    { key: 'consecUp', header: '连涨', align: 'right', max: 6 },
  ];
  for (const k of evidenceKeys) {
    columns.push({
      key: `${EV_PREFIX}${k}` as keyof StockTableItem & string,
      header: k.toUpperCase(),
      align: 'right',
      max: 14,
    });
  }

  return interactive(
    selectableList<StockTableItem>({
      title: opts.title,
      items,
      columns,
      filterFields: ['code', 'name'],
      onCommit: (item) => ({ kind: 'command', line: onCommitLine(item) }),
      extraKeys: [
        {
          key: 'a',
          hint: { keys: ['a'], label: 'analyze (paid)', danger: true },
          resolve: (item) => ({ kind: 'command', line: `analyze ${item.code}` }),
        },
        {
          key: 'f',
          hint: { keys: ['f'], label: 'focus' },
          resolve: (item) => ({ kind: 'command', line: `focus ${item.code}` }),
        },
      ],
    }),
  );
}
