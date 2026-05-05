/**
 * Y/N confirm widget. `danger=true` defaults selection to N and paints the
 * Y option red. Pure (CLAUDE.md §2.5.1).
 */

import { ANSI, paint } from '../render/ansi.js';
import { renderHints } from './hint-bar.js';
import type { CommitResolution, InteractiveWidget, KeyHint, KeySpec, WidgetStep } from './types.js';

export interface ConfirmConfig {
  readonly title: string;
  readonly body?: string;
  readonly danger?: boolean;
  /** When user selects Yes. Required. */
  readonly onYes: () => CommitResolution;
  /** When user selects No (or Esc). Defaults to a no-op. */
  readonly onNo?: () => CommitResolution;
}

export interface ConfirmState {
  readonly selectedYes: boolean;
}

export function confirmPrompt(
  cfg: ConfirmConfig,
): InteractiveWidget<ConfirmState, CommitResolution> {
  const initialState: ConfirmState = { selectedYes: cfg.danger !== true };
  return {
    title: cfg.title,
    initialState,
    hints: () => buildHints(),
    render: (s, w) => renderBody(cfg, s, w),
    snapshot: (s) => `# ${cfg.title}\n[ ${s.selectedYes ? 'YES' : 'NO'} ]`,
    handleKey: (s, key) => handleKey(cfg, s, key),
    commit: (resolution) => resolution,
  } as InteractiveWidget<ConfirmState, CommitResolution>;
}

function buildHints(): readonly KeyHint[] {
  return [
    { keys: ['←', '→'], label: 'select' },
    { keys: ['y'], label: 'yes' },
    { keys: ['n'], label: 'no' },
    { keys: ['Enter'], label: 'confirm' },
    { keys: ['Esc'], label: 'cancel' },
  ];
}

function renderBody(cfg: ConfirmConfig, state: ConfirmState, width: number): string {
  const head = paint(cfg.title, ANSI.bold, cfg.danger === true ? ANSI.red : ANSI.cyan);
  const body = cfg.body !== undefined ? cfg.body : '';
  const yes = state.selectedYes
    ? paint(' YES ', cfg.danger === true ? ANSI.bgRed : ANSI.bgGreen, ANSI.bold)
    : paint(' YES ', ANSI.gray);
  const no = !state.selectedYes
    ? paint(' NO ', ANSI.bgGray, ANSI.bold)
    : paint(' NO ', ANSI.gray);
  const lines: string[] = [head];
  if (body.length > 0) lines.push(body);
  lines.push(`${yes}    ${no}`);
  const hints = renderHints(buildHints(), { width });
  if (hints.length > 0) {
    lines.push(paint('─'.repeat(Math.max(8, Math.min(60, width))), ANSI.gray));
    lines.push(hints);
  }
  return lines.join('\n');
}

function handleKey(
  cfg: ConfirmConfig,
  state: ConfirmState,
  key: KeySpec,
): WidgetStep<ConfirmState, CommitResolution> {
  if (key.special === 'Left' || key.special === 'Right' || key.special === 'Tab') {
    return { kind: 'state', next: { selectedYes: !state.selectedYes } };
  }
  if (key.text === 'y' || key.text === 'Y') {
    return { kind: 'submit', result: cfg.onYes() };
  }
  if (key.text === 'n' || key.text === 'N') {
    return { kind: 'submit', result: cfg.onNo !== undefined ? cfg.onNo() : { kind: 'noop' } };
  }
  if (key.special === 'Enter') {
    if (state.selectedYes) return { kind: 'submit', result: cfg.onYes() };
    return { kind: 'submit', result: cfg.onNo !== undefined ? cfg.onNo() : { kind: 'noop' } };
  }
  return { kind: 'state', next: state };
}
