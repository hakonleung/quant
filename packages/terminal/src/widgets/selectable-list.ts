/**
 * Generic interactive list widget.
 *
 * Up/Down moves the cursor; PgUp/PgDn jumps a page; Home/End to extremes.
 * Slash (`/`) toggles inline filter; printable chars while in filter narrow
 * the list. Enter commits the highlighted row through `onCommit`. Custom
 * single-key shortcuts (e.g. `a` / `d`) are declared via `extraKeys`.
 *
 * Pure (CLAUDE.md §2.5.1). No store / no IO.
 */

import { renderTable, type ColumnSpec } from '../render/table.js';
import { ANSI, paint } from '../render/ansi.js';
import { visualWidth } from '../render/width.js';
import type {
  CommitResolution,
  InteractiveWidget,
  KeyHint,
  KeySpec,
  WidgetStep,
} from './types.js';

export interface SelectableListItem {
  readonly id?: string;
  readonly [k: string]: unknown;
}

export interface ExtraKey<T> {
  /** Single character (e.g. 'a', 'd') — case sensitive. */
  readonly key: string;
  readonly hint: KeyHint;
  /** Resolution returned to the engine when the user presses this key. */
  readonly resolve: (item: T) => CommitResolution;
}

export interface SelectableListConfig<T extends SelectableListItem> {
  readonly title: string;
  readonly items: readonly T[];
  readonly columns: readonly ColumnSpec<T>[];
  readonly emptyHint?: string;
  /** Default Enter behaviour. Returning 'noop' means selection is allowed but does nothing. */
  readonly onCommit?: (item: T) => CommitResolution;
  readonly extraKeys?: readonly ExtraKey<T>[];
  /** Field used for filter matching; defaults to all string fields. */
  readonly filterFields?: readonly (keyof T & string)[];
  /** Visible rows in the viewport (cursor scrolls inside this window). */
  readonly viewportRows?: number;
}

export interface SelectableListState<T extends SelectableListItem> {
  readonly idx: number;
  readonly filter: string;
  readonly inFilter: boolean;
  readonly visible: readonly T[];
  /** Top row of the viewport — `idx` is always within `[scroll, scroll+viewportRows)`. */
  readonly scroll: number;
}

const DEFAULT_VIEWPORT = 10;
const PAGE = DEFAULT_VIEWPORT;

export function selectableList<T extends SelectableListItem>(
  cfg: SelectableListConfig<T>,
): InteractiveWidget<SelectableListState<T>, CommitResolution> {
  const initialState: SelectableListState<T> = {
    idx: 0,
    filter: '',
    inFilter: false,
    visible: cfg.items,
    scroll: 0,
  };

  return {
    title: cfg.title,
    initialState,
    hints: (s) => buildHints(cfg, s),
    render: (s, width) => renderBody(cfg, s, width),
    snapshot: (s) => snapshotBody(cfg, s),
    handleKey: (s, key) => handleKey(cfg, s, key),
    commit: (resolution) => resolution,
  } as InteractiveWidget<SelectableListState<T>, CommitResolution>;
}

function buildHints<T extends SelectableListItem>(
  cfg: SelectableListConfig<T>,
  state: SelectableListState<T>,
): readonly KeyHint[] {
  const hasSelection = state.visible.length > 0;
  const hints: KeyHint[] = [];
  if (state.inFilter) {
    hints.push({ keys: ['type'], label: 'filter' });
    hints.push({ keys: ['Esc'], label: 'exit filter' });
    return hints;
  }
  hints.push({ keys: ['↑', '↓'], label: 'move' });
  if (cfg.onCommit !== undefined && hasSelection) {
    hints.push({ keys: ['Enter'], label: 'pick' });
  }
  hints.push({ keys: ['/'], label: 'filter' });
  // Surface row-action shortcuts (d delete / a analyze / f focus / …)
  // unconditionally when the list has rows so they always appear in the
  // bridge's pinned status bar — the engine-side `when` filter only fires
  // when the bridge passes hasSelection, which it can't know.
  if (hasSelection) {
    for (const k of cfg.extraKeys ?? []) hints.push(k.hint);
  }
  hints.push({ keys: ['Esc'], label: 'back' });
  return hints;
}

function renderBody<T extends SelectableListItem>(
  cfg: SelectableListConfig<T>,
  state: SelectableListState<T>,
  width: number,
): string {
  const head = paint(cfg.title, ANSI.bold, ANSI.cyan);
  const filterLine = state.inFilter
    ? paint(`/${state.filter}`, ANSI.yellow)
    : state.filter.length > 0
      ? paint(`filter:${state.filter}`, ANSI.gray)
      : '';

  const lines = [head];
  if (filterLine.length > 0) lines.push(filterLine);

  if (state.visible.length === 0) {
    lines.push(paint(cfg.emptyHint ?? 'no items', ANSI.gray));
  } else {
    const viewportRows = cfg.viewportRows ?? DEFAULT_VIEWPORT;
    const total = state.visible.length;
    const window = state.visible.slice(state.scroll, state.scroll + viewportRows);
    const table = renderTable(window, cfg.columns, { highlightRow: state.idx - state.scroll });
    lines.push(table);
    if (total > viewportRows) {
      const start = state.scroll + 1;
      const end = Math.min(total, state.scroll + viewportRows);
      const above = state.scroll > 0 ? '↑' : ' ';
      const below = end < total ? '↓' : ' ';
      lines.push(
        paint(`${above} ${String(start)}-${String(end)}/${String(total)} ${below}`, ANSI.gray),
      );
    }
  }

  // Hints are rendered globally by the bridge as a status bar — widgets
  // no longer paint their own.
  void width;
  return lines.join('\n');
}

function snapshotBody<T extends SelectableListItem>(
  cfg: SelectableListConfig<T>,
  state: SelectableListState<T>,
): string {
  // Snapshots are appended to the scrollback as a one-shot frozen entry —
  // they should be a quick summary, not a re-rendered table. The full list
  // is no longer interactive; replaying it as scrollback wastes height.
  const cur = state.visible[state.idx];
  const total = state.visible.length;
  const sel = cur !== undefined ? formatRow(cur, cfg.columns) : '(none)';
  const filter = state.filter.length > 0 ? ` · filter "${state.filter}"` : '';
  return `${cfg.title} → ${sel}  (${String(total)} item${total === 1 ? '' : 's'}${filter})`;
}

function formatRow<T extends SelectableListItem>(
  row: T,
  columns: readonly ColumnSpec<T>[],
): string {
  return columns
    .map((c) => {
      const v = row[c.key];
      return v === undefined || v === null ? '' : String(v);
    })
    .filter((s) => s.length > 0)
    .join(' ');
}

function handleKey<T extends SelectableListItem>(
  cfg: SelectableListConfig<T>,
  state: SelectableListState<T>,
  key: KeySpec,
): WidgetStep<SelectableListState<T>, CommitResolution> {
  if (state.inFilter) {
    return handleFilterKey(cfg, state, key);
  }
  const viewport = cfg.viewportRows ?? DEFAULT_VIEWPORT;
  if (key.special !== undefined) {
    switch (key.special) {
      case 'Up':
        return move(state, -1, viewport);
      case 'Down':
        return move(state, 1, viewport);
      case 'PageUp':
        return move(state, -PAGE, viewport);
      case 'PageDown':
        return move(state, PAGE, viewport);
      case 'Home':
        return { kind: 'state', next: { ...state, idx: 0, scroll: 0 } };
      case 'End': {
        const last = Math.max(0, state.visible.length - 1);
        return {
          kind: 'state',
          next: { ...state, idx: last, scroll: clampScroll(last, state.visible.length, viewport) },
        };
      }
      case 'Enter': {
        const item = state.visible[state.idx];
        if (item === undefined || cfg.onCommit === undefined) {
          return { kind: 'state', next: state };
        }
        return { kind: 'submit', result: cfg.onCommit(item) };
      }
      default:
        return { kind: 'state', next: state };
    }
  }
  if (key.text !== undefined) {
    if (key.text === '/') {
      return { kind: 'state', next: { ...state, inFilter: true, filter: '' } };
    }
    const extra = (cfg.extraKeys ?? []).find((k) => k.key === key.text);
    if (extra !== undefined) {
      const item = state.visible[state.idx];
      if (item === undefined) return { kind: 'state', next: state };
      return { kind: 'submit', result: extra.resolve(item) };
    }
  }
  return { kind: 'state', next: state };
}

function handleFilterKey<T extends SelectableListItem>(
  cfg: SelectableListConfig<T>,
  state: SelectableListState<T>,
  key: KeySpec,
): WidgetStep<SelectableListState<T>, CommitResolution> {
  if (key.special === 'Enter') {
    return { kind: 'state', next: { ...state, inFilter: false } };
  }
  if (key.special === 'Escape') {
    // Exit filter sub-state and reset the filter — user wants to back out
    // of typing, not to cancel the whole list interaction.
    return {
      kind: 'state',
      next: { ...state, inFilter: false, filter: '', visible: cfg.items, idx: 0, scroll: 0 },
    };
  }
  if (key.special === 'Backspace') {
    const filter = state.filter.slice(0, -1);
    const visible = applyFilter(cfg, filter);
    return {
      kind: 'state',
      next: { ...state, filter, visible, idx: 0, scroll: 0 },
    };
  }
  if (key.text !== undefined && key.text !== '/') {
    const filter = state.filter + key.text;
    const visible = applyFilter(cfg, filter);
    return {
      kind: 'state',
      next: { ...state, filter, visible, idx: 0, scroll: 0 },
    };
  }
  return { kind: 'state', next: state };
}

function move<T extends SelectableListItem>(
  state: SelectableListState<T>,
  delta: number,
  viewport: number,
): WidgetStep<SelectableListState<T>, CommitResolution> {
  const max = state.visible.length - 1;
  if (max < 0) return { kind: 'state', next: state };
  const idx = Math.min(max, Math.max(0, state.idx + delta));
  const scroll = clampScroll(idx, state.visible.length, viewport, state.scroll);
  return { kind: 'state', next: { ...state, idx, scroll } };
}

/** Keep `idx` inside `[scroll, scroll+viewport)` and within bounds. */
function clampScroll(idx: number, total: number, viewport: number, prev = 0): number {
  if (total <= viewport) return 0;
  let scroll = prev;
  if (idx < scroll) scroll = idx;
  else if (idx >= scroll + viewport) scroll = idx - viewport + 1;
  if (scroll < 0) scroll = 0;
  if (scroll > total - viewport) scroll = total - viewport;
  return scroll;
}

function applyFilter<T extends SelectableListItem>(
  cfg: SelectableListConfig<T>,
  filter: string,
): readonly T[] {
  if (filter.length === 0) return cfg.items;
  const needle = filter.toLowerCase();
  const fields =
    cfg.filterFields ??
    (cfg.columns.map((c) => c.key) as readonly (keyof T & string)[]);
  return cfg.items.filter((item) =>
    fields.some((f) => {
      const v = item[f];
      return typeof v === 'string' && v.toLowerCase().includes(needle);
    }),
  );
}

// Re-exported helper used by widget tests / external table-only consumers
export { visualWidth };
