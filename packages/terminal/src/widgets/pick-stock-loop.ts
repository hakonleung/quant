/**
 * "Loop a search → add → repeat" widget. Used by `sector add` user-kind to
 * build up a basket of codes one at a time.
 *
 * Pure (CLAUDE.md §2.5.1).
 */

import { ANSI, paint } from '../render/ansi.js';
import { renderTable } from '../render/table.js';
import type {
  CommitResolution,
  InteractiveWidget,
  KeyHint,
  KeySpec,
  WidgetStep,
} from './types.js';

export interface StockLite {
  readonly code: string;
  readonly name: string;
}

export interface PickStockLoopConfig {
  readonly title: string;
  readonly universe: readonly StockLite[];
  readonly onApply: (codes: readonly string[]) => CommitResolution;
  readonly maxBasket?: number;
}

export interface PickStockLoopState {
  readonly query: string;
  readonly idx: number;
  readonly basket: readonly StockLite[];
}

export function pickStockLoop(
  cfg: PickStockLoopConfig,
): InteractiveWidget<PickStockLoopState, CommitResolution> {
  return {
    title: cfg.title,
    initialState: { query: '', idx: 0, basket: [] },
    hints: () => buildHints(),
    render: (s, w) => renderBody(cfg, s, w),
    snapshot: (s) => snapshotBody(cfg, s),
    handleKey: (s, key) => handleKey(cfg, s, key),
    commit: (resolution) => resolution,
  } as InteractiveWidget<PickStockLoopState, CommitResolution>;
}

function buildHints(): readonly KeyHint[] {
  return [
    { keys: ['↑', '↓'], label: 'pick' },
    { keys: ['Enter'], label: 'add to basket' },
    { keys: ['type'], label: 'search code/name' },
    { keys: ['Backspace'], label: 'edit search' },
    { keys: ['Ctrl+D'], label: 'pop last' },
    { keys: ['a'], label: 'apply' },
    { keys: ['Esc'], label: 'cancel' },
  ];
}

function renderBody(cfg: PickStockLoopConfig, state: PickStockLoopState, width: number): string {
  const head = paint(cfg.title, ANSI.bold, ANSI.cyan);
  const queryLine = `> ${state.query.length === 0 ? paint('(type to search)', ANSI.gray) : state.query}`;
  const matches = filterMatches(cfg.universe, state.query, 8);
  const list = matches.length === 0
    ? paint('no matches', ANSI.gray)
    : renderTable(
        matches as unknown as readonly Record<string, unknown>[],
        [
          { key: 'code', header: 'CODE', max: 8 },
          { key: 'name', header: 'NAME', max: 14 },
        ],
        { highlightRow: state.idx },
      );
  const basketLine =
    state.basket.length === 0
      ? paint('basket: (empty)', ANSI.gray)
      : `basket: ${state.basket.map((s) => `${s.code} ${s.name}`).join(', ')}`;
  void width;
  return [head, queryLine, list, basketLine].join('\n');
}

function snapshotBody(cfg: PickStockLoopConfig, state: PickStockLoopState): string {
  return [
    `# ${cfg.title}`,
    `query: ${state.query}`,
    `basket: ${state.basket.map((s) => s.code).join(',')}`,
  ].join('\n');
}

function handleKey(
  cfg: PickStockLoopConfig,
  state: PickStockLoopState,
  key: KeySpec,
): WidgetStep<PickStockLoopState, CommitResolution> {
  const matches = filterMatches(cfg.universe, state.query, 8);
  if (key.special === 'Up') {
    return { kind: 'state', next: { ...state, idx: Math.max(0, state.idx - 1) } };
  }
  if (key.special === 'Down') {
    return {
      kind: 'state',
      next: { ...state, idx: Math.min(Math.max(0, matches.length - 1), state.idx + 1) },
    };
  }
  if (key.special === 'Enter') {
    const pick = matches[state.idx];
    if (pick === undefined) return { kind: 'state', next: state };
    const exists = state.basket.some((b) => b.code === pick.code);
    if (exists) return { kind: 'state', next: { ...state, query: '' } };
    if (cfg.maxBasket !== undefined && state.basket.length >= cfg.maxBasket) {
      return { kind: 'state', next: state };
    }
    return {
      kind: 'state',
      next: { ...state, basket: [...state.basket, pick], query: '', idx: 0 },
    };
  }
  if (key.special === 'Backspace') {
    return {
      kind: 'state',
      next: { ...state, query: state.query.slice(0, -1), idx: 0 },
    };
  }
  if (key.special === 'CtrlD') {
    if (state.basket.length === 0) return { kind: 'state', next: state };
    return { kind: 'state', next: { ...state, basket: state.basket.slice(0, -1) } };
  }
  if (key.text === 'a' && state.basket.length > 0) {
    return { kind: 'submit', result: cfg.onApply(state.basket.map((b) => b.code)) };
  }
  if (key.text !== undefined && key.text.length >= 1) {
    return { kind: 'state', next: { ...state, query: state.query + key.text, idx: 0 } };
  }
  return { kind: 'state', next: state };
}

function filterMatches(
  universe: readonly StockLite[],
  query: string,
  limit: number,
): readonly StockLite[] {
  if (query.length === 0) return universe.slice(0, limit);
  const q = query.toLowerCase();
  const matches: StockLite[] = [];
  for (const s of universe) {
    if (s.code.includes(q) || s.name.toLowerCase().includes(q)) {
      matches.push(s);
      if (matches.length >= limit) break;
    }
  }
  return matches;
}
