/**
 * Multi-line text editor widget. Used by `sector add` (paste-json / paste-csv)
 * and any future command needing free-form text input.
 *
 * - Enter inserts newline.
 * - Ctrl-Enter (or Ctrl-D when buffer non-empty) submits.
 * - Esc cancels.
 * - Backspace deletes one char to the left of the cursor (line/cursor flat).
 *
 * Pure (CLAUDE.md §2.5.1).
 */

import { ANSI, paint } from '../render/ansi.js';
import type {
  CommitResolution,
  InteractiveWidget,
  KeyHint,
  KeySpec,
  WidgetStep,
} from './types.js';

export interface PasteTextConfig {
  readonly title: string;
  readonly placeholder?: string;
  readonly onSubmit: (text: string) => CommitResolution;
}

export interface PasteTextState {
  readonly buffer: string;
  readonly cursor: number;
}

export function pasteText(cfg: PasteTextConfig): InteractiveWidget<PasteTextState, CommitResolution> {
  return {
    title: cfg.title,
    initialState: { buffer: '', cursor: 0 },
    hints: () => buildHints(),
    render: (s, w) => renderBody(cfg, s, w),
    snapshot: (s) => `# ${cfg.title}\n${s.buffer}`,
    handleKey: (s, key) => handleKey(cfg, s, key),
    commit: (resolution) => resolution,
  } as InteractiveWidget<PasteTextState, CommitResolution>;
}

function buildHints(): readonly KeyHint[] {
  return [
    { keys: ['Ctrl+Enter'], label: 'submit' },
    { keys: ['Enter'], label: 'newline' },
    { keys: ['Backspace'], label: 'delete' },
    { keys: ['Esc'], label: 'cancel' },
  ];
}

function renderBody(cfg: PasteTextConfig, state: PasteTextState, width: number): string {
  const head = paint(cfg.title, ANSI.bold, ANSI.cyan);
  const body = state.buffer.length === 0
    ? paint(cfg.placeholder ?? '(paste or type, Ctrl+Enter to submit)', ANSI.gray)
    : state.buffer;
  const lines = [head, body];
  void width;
  return lines.join('\n');
}

function handleKey(
  cfg: PasteTextConfig,
  state: PasteTextState,
  key: KeySpec,
): WidgetStep<PasteTextState, CommitResolution> {
  if (key.special === 'CtrlEnter' || (key.special === 'CtrlD' && state.buffer.length > 0)) {
    return { kind: 'submit', result: cfg.onSubmit(state.buffer) };
  }
  if (key.special === 'Enter') {
    return insert(state, '\n');
  }
  if (key.special === 'Backspace') {
    if (state.cursor === 0) return { kind: 'state', next: state };
    return {
      kind: 'state',
      next: {
        buffer: state.buffer.slice(0, state.cursor - 1) + state.buffer.slice(state.cursor),
        cursor: state.cursor - 1,
      },
    };
  }
  if (key.text !== undefined) {
    return insert(state, key.text);
  }
  return { kind: 'state', next: state };
}

function insert(state: PasteTextState, text: string): WidgetStep<PasteTextState, CommitResolution> {
  return {
    kind: 'state',
    next: {
      buffer: state.buffer.slice(0, state.cursor) + text + state.buffer.slice(state.cursor),
      cursor: state.cursor + text.length,
    },
  };
}
