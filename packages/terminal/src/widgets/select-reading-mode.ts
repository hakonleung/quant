/**
 * Two-option reading-mode picker for `analyze` flows. The user chooses
 * between a `brief` ANSI summary (the existing inline output) and a
 * `detail` markdown document opened in the in-terminal pager.
 *
 * Pure (CLAUDE.md §2.5.1).
 */

import { ANSI, paint } from '../render/ansi.js';
import type { CommitResolution, InteractiveWidget, KeyHint, KeySpec, WidgetStep } from './types.js';

export type ReadingMode = 'brief' | 'detail';

export interface SelectReadingModeConfig {
  readonly title: string;
  readonly onPick: (mode: ReadingMode) => CommitResolution;
}

export interface SelectReadingModeState {
  readonly idx: 0 | 1;
}

const OPTIONS: readonly { readonly mode: ReadingMode; readonly label: string }[] = [
  { mode: 'brief', label: 'brief    — ANSI summary inline' },
  { mode: 'detail', label: 'detail   — full document in pager (j/k/space, q to quit)' },
];

export function selectReadingMode(
  cfg: SelectReadingModeConfig,
): InteractiveWidget<SelectReadingModeState, CommitResolution> {
  return {
    title: cfg.title,
    initialState: { idx: 0 },
    hints: () => HINTS,
    render: (s) => renderBody(cfg, s),
    snapshot: (s) => `${cfg.title} → ${OPTIONS[s.idx]!.mode}`,
    handleKey: (s, key) => handleKey(cfg, s, key),
    commit: (resolution) => resolution,
  } as InteractiveWidget<SelectReadingModeState, CommitResolution>;
}

const HINTS: readonly KeyHint[] = [
  { keys: ['↑', '↓'], label: 'pick' },
  { keys: ['Enter'], label: 'open' },
  { keys: ['b'], label: 'brief' },
  { keys: ['d'], label: 'detail' },
  { keys: ['Esc'], label: 'cancel' },
];

function renderBody(cfg: SelectReadingModeConfig, state: SelectReadingModeState): string {
  const head = paint(cfg.title, ANSI.bold, ANSI.cyan);
  const lines = OPTIONS.map((opt, i) => {
    const cur = state.idx === i;
    const marker = cur ? '▸' : ' ';
    const text = `${marker} ${opt.label}`;
    return cur ? paint(text, ANSI.bold, ANSI.cyan) : text;
  });
  return [head, ...lines].join('\n');
}

function handleKey(
  cfg: SelectReadingModeConfig,
  state: SelectReadingModeState,
  key: KeySpec,
): WidgetStep<SelectReadingModeState, CommitResolution> {
  if (key.special === 'Up') {
    return { kind: 'state', next: { idx: 0 } };
  }
  if (key.special === 'Down') {
    return { kind: 'state', next: { idx: 1 } };
  }
  if (key.special === 'Enter') {
    return { kind: 'submit', result: cfg.onPick(OPTIONS[state.idx]!.mode) };
  }
  if (key.text === 'b' || key.text === 'B') {
    return { kind: 'submit', result: cfg.onPick('brief') };
  }
  if (key.text === 'd' || key.text === 'D') {
    return { kind: 'submit', result: cfg.onPick('detail') };
  }
  return { kind: 'state', next: state };
}
