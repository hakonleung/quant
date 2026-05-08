/**
 * In-terminal pager — a less-like reader for long output (analyze
 * detail, help docs). The widget owns its own scroll position and
 * filter state; the engine just feeds it keys.
 *
 * Keys:
 *   ↑ / k           scroll up by 1 line
 *   ↓ / j           scroll down by 1 line
 *   Space / PageDn  scroll down by one viewport
 *   PageUp / b      scroll up by one viewport
 *   Home / g        jump to top
 *   End / G         jump to bottom
 *   /               enter search mode
 *   Backspace       (search) edit the query
 *   Enter           (search) jump to first match (or next match if any)
 *   n / N           next / prev match
 *   Esc / q         exit (cancel)
 *
 * Pure (CLAUDE.md §2.5.1).
 */

import { ANSI, paint } from '../render/ansi.js';
import type { CommitResolution, InteractiveWidget, KeyHint, KeySpec, WidgetStep } from './types.js';

export interface PagerConfig {
  readonly title: string;
  /** Body text (any line ending; `\n` is the separator after split). */
  readonly body: string;
  /** Visible rows in the pager viewport. */
  readonly viewportRows?: number;
  /** Optional commit handler when the user submits with Enter outside search. */
  readonly onClose?: () => CommitResolution;
}

export interface PagerState {
  readonly lines: readonly string[];
  readonly scroll: number;
  readonly viewportRows: number;
  readonly inSearch: boolean;
  readonly query: string;
  /** Sorted list of line indices that match the active query. */
  readonly matches: readonly number[];
  /** Index into `matches` of the currently-highlighted match. */
  readonly matchIdx: number;
}

const DEFAULT_VIEWPORT = 16;

export function pager(cfg: PagerConfig): InteractiveWidget<PagerState, CommitResolution> {
  const lines = cfg.body.length === 0 ? [''] : cfg.body.split('\n');
  const initialState: PagerState = {
    lines,
    scroll: 0,
    viewportRows: cfg.viewportRows ?? DEFAULT_VIEWPORT,
    inSearch: false,
    query: '',
    matches: [],
    matchIdx: -1,
  };

  return {
    title: cfg.title,
    initialState,
    hints: (s) => buildHints(s),
    render: (s) => renderBody(cfg, s),
    snapshot: (s) => snapshot(cfg, s),
    handleKey: (s, key) => handleKey(cfg, s, key),
    commit: (resolution) => resolution,
  } as InteractiveWidget<PagerState, CommitResolution>;
}

function buildHints(state: PagerState): readonly KeyHint[] {
  if (state.inSearch) {
    return [
      { keys: ['type'], label: 'search' },
      { keys: ['Enter'], label: 'first match' },
      { keys: ['Esc'], label: 'cancel search' },
    ];
  }
  return [
    { keys: ['j', '↓'], label: 'down' },
    { keys: ['k', '↑'], label: 'up' },
    { keys: ['Space'], label: 'page' },
    { keys: ['g', 'G'], label: 'top/bot' },
    { keys: ['/'], label: 'search' },
    { keys: ['n', 'N'], label: 'next/prev match' },
    { keys: ['q', 'Esc'], label: 'close' },
  ];
}

function renderBody(cfg: PagerConfig, state: PagerState): string {
  const head = paint(cfg.title, ANSI.bold, ANSI.cyan);
  const total = state.lines.length;
  const viewport = state.viewportRows;
  const window = state.lines.slice(state.scroll, state.scroll + viewport);
  const start = state.scroll + 1;
  const end = Math.min(total, state.scroll + viewport);
  const ratio = total === 0 ? 100 : Math.floor((end / total) * 100);
  const status = paint(
    `── ${cfg.title} ── ${String(start)}-${String(end)}/${String(total)}  ${String(ratio)}%`,
    ANSI.gray,
  );
  const search = state.inSearch
    ? paint(`/${state.query}`, ANSI.yellow)
    : state.query.length === 0
      ? ''
      : paint(
          `match ${state.matches.length === 0 ? '0' : String(state.matchIdx + 1)}/${String(state.matches.length)}: ${state.query}`,
          ANSI.gray,
        );
  const out: string[] = [head];
  if (search.length > 0) out.push(search);
  for (const line of window) out.push(highlightLine(line, state.query));
  // Pad short windows so the status bar stays glued to the bottom.
  for (let i = window.length; i < viewport; i += 1) out.push('');
  out.push(status);
  return out.join('\n');
}

function highlightLine(line: string, query: string): string {
  if (query.length === 0) return line;
  const lc = line.toLowerCase();
  const lq = query.toLowerCase();
  const idx = lc.indexOf(lq);
  if (idx === -1) return line;
  const before = line.slice(0, idx);
  const hit = line.slice(idx, idx + query.length);
  const after = line.slice(idx + query.length);
  return `${before}${paint(hit, ANSI.bgYellow ?? ANSI.yellow, ANSI.bold)}${after}`;
}

function snapshot(cfg: PagerConfig, state: PagerState): string {
  const total = state.lines.length;
  return `${cfg.title} (${String(total)} line${total === 1 ? '' : 's'})`;
}

function handleKey(
  cfg: PagerConfig,
  state: PagerState,
  key: KeySpec,
): WidgetStep<PagerState, CommitResolution> {
  if (state.inSearch) return handleSearchKey(state, key);

  if (key.special !== undefined) {
    switch (key.special) {
      case 'Up':
        return scrollBy(state, -1);
      case 'Down':
        return scrollBy(state, 1);
      case 'PageUp':
        return scrollBy(state, -state.viewportRows);
      case 'PageDown':
        return scrollBy(state, state.viewportRows);
      case 'Home':
        return jumpTo(state, 0);
      case 'End':
        return jumpTo(state, lastScroll(state));
      case 'Escape':
        return cancel(cfg);
      default:
        return { kind: 'state', next: state };
    }
  }

  if (key.text === undefined) return { kind: 'state', next: state };
  switch (key.text) {
    case 'j':
      return scrollBy(state, 1);
    case 'k':
      return scrollBy(state, -1);
    case ' ':
      return scrollBy(state, state.viewportRows);
    case 'b':
      return scrollBy(state, -state.viewportRows);
    case 'g':
      return jumpTo(state, 0);
    case 'G':
      return jumpTo(state, lastScroll(state));
    case '/':
      return { kind: 'state', next: { ...state, inSearch: true, query: '' } };
    case 'n':
      return jumpToMatch(state, +1);
    case 'N':
      return jumpToMatch(state, -1);
    case 'q':
      return cancel(cfg);
    default:
      return { kind: 'state', next: state };
  }
}

function handleSearchKey(
  state: PagerState,
  key: KeySpec,
): WidgetStep<PagerState, CommitResolution> {
  if (key.special === 'Escape') {
    return {
      kind: 'state',
      next: { ...state, inSearch: false, query: '', matches: [], matchIdx: -1 },
    };
  }
  if (key.special === 'Enter') {
    const matches = findMatches(state.lines, state.query);
    if (matches.length === 0) {
      return { kind: 'state', next: { ...state, inSearch: false, matches: [], matchIdx: -1 } };
    }
    const target = matches[0]!;
    return {
      kind: 'state',
      next: {
        ...state,
        inSearch: false,
        matches,
        matchIdx: 0,
        scroll: clampScroll(target, state.lines.length, state.viewportRows),
      },
    };
  }
  if (key.special === 'Backspace') {
    const query = state.query.slice(0, -1);
    return { kind: 'state', next: { ...state, query } };
  }
  if (key.text !== undefined && key.text.length > 0) {
    return { kind: 'state', next: { ...state, query: state.query + key.text } };
  }
  return { kind: 'state', next: state };
}

function scrollBy(state: PagerState, delta: number): WidgetStep<PagerState, CommitResolution> {
  return jumpTo(state, state.scroll + delta);
}

function jumpTo(state: PagerState, target: number): WidgetStep<PagerState, CommitResolution> {
  const max = lastScroll(state);
  const clamped = Math.max(0, Math.min(max, target));
  return { kind: 'state', next: { ...state, scroll: clamped } };
}

function jumpToMatch(state: PagerState, dir: 1 | -1): WidgetStep<PagerState, CommitResolution> {
  if (state.matches.length === 0) return { kind: 'state', next: state };
  const len = state.matches.length;
  const next = (state.matchIdx + dir + len) % len;
  const target = state.matches[next]!;
  return {
    kind: 'state',
    next: {
      ...state,
      matchIdx: next,
      scroll: clampScroll(target, state.lines.length, state.viewportRows),
    },
  };
}

function cancel(cfg: PagerConfig): WidgetStep<PagerState, CommitResolution> {
  const close = cfg.onClose;
  return {
    kind: 'submit',
    result: close === undefined ? { kind: 'noop' } : close(),
  };
}

function lastScroll(state: PagerState): number {
  return Math.max(0, state.lines.length - state.viewportRows);
}

function clampScroll(target: number, total: number, viewport: number): number {
  if (total <= viewport) return 0;
  let scroll = target;
  if (scroll > total - viewport) scroll = total - viewport;
  if (scroll < 0) scroll = 0;
  return scroll;
}

function findMatches(lines: readonly string[], query: string): readonly number[] {
  if (query.length === 0) return [];
  const needle = query.toLowerCase();
  const out: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i]!.toLowerCase().includes(needle)) out.push(i);
  }
  return out;
}
