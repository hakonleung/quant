/**
 * Terminal engine state, events, and the InteractiveSession contract.
 *
 * This file holds **only types** — no runtime behavior. Pure module
 * (CLAUDE.md §2.5.1).
 */

import type { KeySpec } from './keymap.js';

export type Phase = 'idle' | 'running' | 'cancelling' | 'interactive';

export interface PromptEntry {
  readonly kind: 'prompt';
  readonly id: string;
  readonly text: string;
}

export interface OutputEntry {
  readonly kind: 'output';
  readonly id: string;
  /** ANSI-colored text, `\n`-separated lines. */
  readonly body: string;
  readonly status: 'ok' | 'err' | 'cached' | 'info';
}

export interface FrozenInteractiveEntry {
  readonly kind: 'frozen';
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly status: 'ok' | 'err' | 'info';
}

export type HistoryEntry = PromptEntry | OutputEntry | FrozenInteractiveEntry;

export interface KeyHint {
  readonly keys: readonly string[];
  readonly label: string;
  readonly danger?: boolean | undefined;
  readonly when?: 'always' | 'whenItemSelected' | 'whenFilter' | undefined;
}

/**
 * A pure description of one interactive widget. Widgets have no IO of their
 * own; the engine takes their `WidgetStep` output and drives side effects
 * via the dispatcher.
 *
 * NOTE: `commit` is optional but the type union explicitly includes
 * `undefined` so this widget shape stays assignable to
 * `InteractiveWidget<unknown, unknown>` under
 * `exactOptionalPropertyTypes: true`. Same for any future optional fields.
 */
export interface InteractiveWidget<S, R> {
  readonly title: string;
  readonly initialState: S;
  readonly hints: (state: S) => readonly KeyHint[];
  /**
   * `width` is the terminal column count, `rows` (when provided) is the
   * visible row count. Widgets that paint a fixed-height body (e.g.
   * the pager) should resize themselves to `rows` so the body never
   * scrolls off-screen on a small viewport (mobile term, split panes).
   * Older widgets ignore `rows` — keeping it optional preserves their
   * existing render signatures.
   */
  readonly render: (state: S, width: number, rows?: number) => string;
  readonly handleKey: (state: S, key: KeySpec) => WidgetStep<S, R>;
  /** Called when the session is frozen into history. */
  readonly snapshot: (state: S) => string;
  /** Called when the user submits — converts the widget result into `next`. */
  readonly commit?: ((result: R) => CommitResolution) | undefined;
}

export type WidgetStep<S, R> =
  | { readonly kind: 'state'; readonly next: S }
  | { readonly kind: 'submit'; readonly result: R }
  | { readonly kind: 'cancel' };

/**
 * What a widget does on submit:
 *   - 'command' — push a new prompt and run it
 *   - 'widget'  — chain into the next widget without going back to idle
 *   - 'output'  — finalize with a literal output entry (e.g. "[ok] saved")
 *   - 'noop'    — just close the session
 */
export type CommitResolution =
  | { readonly kind: 'command'; readonly line: string }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | { readonly kind: 'widget'; readonly next: InteractiveWidget<any, any> }
  | { readonly kind: 'output'; readonly entry: Omit<OutputEntry, 'id' | 'kind'> }
  /** User-initiated abort of the current interaction; collapses to "canceled". */
  | { readonly kind: 'canceled' }
  | { readonly kind: 'noop' };

export type CommitResolutionAny = CommitResolution;

/**
 * Erased widget type — the runtime carrier for sessions and events. We can't
 * keep `<S, R>` alive because the reducer needs to store any widget shape
 * regardless of its parameterized state type. `unknown` would force callers
 * to cast on every step; `any` here is contained to two structural fields
 * (`hints`, `render`, `handleKey`) and never escapes the engine boundary.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type InteractiveWidgetAny = InteractiveWidget<any, any>;

export interface InteractiveSession {
  readonly widget: InteractiveWidgetAny;
  readonly state: unknown;
}

export interface TerminalState {
  readonly phase: Phase;
  readonly history: readonly HistoryEntry[];
  /** Editing buffer for the prompt line (idle/running). */
  readonly buffer: string;
  /** Caret position inside `buffer` (0-based). */
  readonly cursor: number;
  /** Submitted command history for ↑/↓ recall. */
  readonly cmdHistory: readonly string[];
  /** Index into `cmdHistory` while browsing; -1 means "editing a fresh line". */
  readonly cmdIndex: number;
  /** Saved buffer when the user starts browsing cmdHistory. */
  readonly savedBuffer: string;
  /** Active interactive widget — only when `phase === 'interactive'`. */
  readonly active: InteractiveSession | null;
  /** Transient completion candidates (cleared on next key press). */
  readonly candidates: readonly string[];
  /** Monotonically increasing id counter for history entries. */
  readonly nextId: number;
}

export const initialState: TerminalState = {
  phase: 'idle',
  history: [],
  buffer: '',
  cursor: 0,
  cmdHistory: [],
  cmdIndex: -1,
  savedBuffer: '',
  active: null,
  candidates: [],
  nextId: 1,
};

/* ---------- Events ---------- */

export type Event =
  | { readonly kind: 'key'; readonly key: KeySpec }
  | { readonly kind: 'submit'; readonly line: string }
  | {
      readonly kind: 'result';
      readonly entry: Omit<OutputEntry, 'id' | 'kind'>;
    }
  | { readonly kind: 'startInteractive'; readonly widget: InteractiveWidgetAny }
  | { readonly kind: 'exitInteractive'; readonly reason: 'cancel' | 'commit' }
  | { readonly kind: 'cancel' }
  /** Replace the current buffer (used by Tab completion). */
  | { readonly kind: 'setBuffer'; readonly buffer: string; readonly cursor: number }
  /** Show a transient list of completion candidates beneath the prompt. */
  | { readonly kind: 'setCandidates'; readonly candidates: readonly string[] }
  /** Drop the last N "interactions" (a prompt + its trailing entries). */
  | { readonly kind: 'clearLast'; readonly count: number }
  /** Wipe all history (engine-level clear). */
  | { readonly kind: 'clearAll' };

/* ---------- Effects ---------- */

/**
 * Side-effect descriptors that the reducer emits alongside the next state.
 * The host (dispatcher) consumes these to invoke async work; the reducer
 * itself stays pure.
 */
export type Effect =
  | { readonly kind: 'runCommand'; readonly line: string }
  | { readonly kind: 'commitWidget'; readonly resolution: CommitResolutionAny }
  | { readonly kind: 'abort' }
  | { readonly kind: 'completionRequested' };

export interface ReduceResult {
  readonly state: TerminalState;
  readonly effects: readonly Effect[];
}
