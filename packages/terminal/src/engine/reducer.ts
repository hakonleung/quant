/**
 * Pure reducer for the terminal engine.
 *
 * Translates `Event`s into `(nextState, effects)`. Side effects (network
 * calls, store mutations) are emitted as `Effect` descriptors so the
 * reducer itself remains pure and 100% unit-testable (CLAUDE.md §2.5.1).
 */

import type { KeySpec } from './keymap.js';
import {
  type Effect,
  type Event,
  type HistoryEntry,
  type OutputEntry,
  type ReduceResult,
  type TerminalState,
  initialState,
} from './state.js';

const MAX_CMD_HISTORY = 100;

/** Canonical reducer entry point. */
export function reduce(state: TerminalState, event: Event): ReduceResult {
  switch (event.kind) {
    case 'key':
      return handleKey(state, event.key);
    case 'submit':
      return handleSubmit(state, event.line);
    case 'result':
      return handleResult(state, event.entry);
    case 'startInteractive':
      return {
        state: {
          ...state,
          phase: 'interactive',
          active: { widget: event.widget, state: event.widget.initialState },
          candidates: [],
        },
        effects: [],
      };
    case 'exitInteractive':
      return handleExitInteractive(state, event.reason);
    case 'cancel':
      return handleCancel(state);
    case 'setBuffer':
      return {
        state: { ...state, buffer: event.buffer, cursor: event.cursor, candidates: [] },
        effects: [],
      };
    case 'setCandidates':
      return { state: { ...state, candidates: event.candidates }, effects: [] };
    case 'clearLast':
      return handleClearLast(state, event.count);
    case 'clearAll':
      // Synchronous engine command — always end on idle, never linger in
      // `running` or `cancelling`.
      return { state: { ...state, phase: 'idle', history: [] }, effects: [] };
    case 'streamOpen':
      return handleStreamOpen(state, event.streamId, event.status, event.initialBody);
    case 'streamChunk':
      return handleStreamMutate(state, event.streamId, (body) => body + event.delta);
    case 'streamStepLog':
      return handleStreamMutate(state, event.streamId, (body) => {
        const sep = body.length > 0 && !body.endsWith('\n') ? '\n' : '';
        return body + sep + event.line;
      });
    case 'streamClose':
      return handleStreamClose(state, event.streamId, event.footer, event.status);
    default:
      return { state, effects: [] };
  }
}

/* ---------- streaming output ---------- */

/**
 * Append a fresh streaming OutputEntry. `streamId` is treated as the
 * entry id so subsequent `streamChunk` / `streamStepLog` / `streamClose`
 * events can find the right row by id.
 *
 * If a streaming entry with the same id is already present we no-op
 * rather than push a duplicate — protects against accidental double-open.
 */
function handleStreamOpen(
  state: TerminalState,
  streamId: string,
  status: OutputEntry['status'] | undefined,
  initialBody: string | undefined,
): ReduceResult {
  if (state.history.some((h) => h.kind === 'output' && h.id === streamId)) {
    return { state, effects: [] };
  }
  const entry: OutputEntry = {
    kind: 'output',
    id: streamId,
    body: initialBody ?? '',
    status: status ?? 'info',
    streaming: true,
  };
  return {
    state: { ...state, history: [...state.history, entry] },
    effects: [],
  };
}

function handleStreamMutate(
  state: TerminalState,
  streamId: string,
  mutate: (body: string) => string,
): ReduceResult {
  const next = state.history.map((h) => {
    if (h.kind !== 'output' || h.id !== streamId) return h;
    return { ...h, body: mutate(h.body) };
  });
  return { state: { ...state, history: next }, effects: [] };
}

function handleStreamClose(
  state: TerminalState,
  streamId: string,
  footer: string | undefined,
  status: OutputEntry['status'] | undefined,
): ReduceResult {
  const next = state.history.map((h) => {
    if (h.kind !== 'output' || h.id !== streamId) return h;
    const sep = h.body.length > 0 && !h.body.endsWith('\n') ? '\n' : '';
    const body = footer !== undefined ? h.body + sep + footer : h.body;
    const updated: OutputEntry = {
      ...h,
      body,
      streaming: false,
      ...(status !== undefined ? { status } : {}),
    };
    return updated;
  });
  // Streaming usually runs detached from the prompt's own running phase;
  // we don't force phase=idle here because the caller's command may have
  // already ended via a separate `result` event. Reducer stays oblivious.
  return { state: { ...state, history: next }, effects: [] };
}

/**
 * Drop the last N "interactions". An interaction starts at a `prompt` entry
 * and includes everything until (but not including) the next `prompt`. The
 * tail of the buffer that contains no prompt at all (e.g. the welcome banner
 * gets converted to entries via output) is treated as one extra interaction
 * only if it sits to the right of every prompt.
 */
function handleClearLast(state: TerminalState, count: number): ReduceResult {
  if (count <= 0 || state.history.length === 0) {
    return { state: { ...state, phase: 'idle' }, effects: [] };
  }
  const promptIdx: number[] = [];
  state.history.forEach((h, i) => {
    if (h.kind === 'prompt') promptIdx.push(i);
  });
  if (promptIdx.length === 0) {
    return { state: { ...state, phase: 'idle' }, effects: [] };
  }
  const drop = Math.min(count, promptIdx.length);
  const cutFrom = promptIdx[promptIdx.length - drop] ?? state.history.length;
  return {
    state: { ...state, phase: 'idle', history: state.history.slice(0, cutFrom) },
    effects: [],
  };
}

/* ---------- key handling ---------- */

function handleKey(state: TerminalState, key: KeySpec): ReduceResult {
  if (state.phase === 'interactive') {
    return handleInteractiveKey(state, key);
  }
  if (state.phase === 'cancelling') {
    // A second Ctrl+C in cancelling-state force-exits to idle in case the
    // running command never honors the abort signal (synchronous engine
    // commands don't have anything to abort).
    if (key.special === 'CtrlC') return { state: { ...state, phase: 'idle' }, effects: [] };
    return { state, effects: [] };
  }
  if (state.phase === 'running') {
    if (key.special === 'CtrlC') return handleCancel(state);
    return { state, effects: [] };
  }

  // idle
  if (key.special !== undefined) {
    switch (key.special) {
      case 'Tab':
        return {
          state: { ...state, candidates: [] },
          effects: [{ kind: 'completionRequested' }],
        };
      case 'Enter':
        return handleSubmit(state, state.buffer);
      case 'Backspace':
        if (state.cursor === 0) return { state, effects: [] };
        return {
          state: {
            ...state,
            buffer: state.buffer.slice(0, state.cursor - 1) + state.buffer.slice(state.cursor),
            cursor: state.cursor - 1,
          },
          effects: [],
        };
      case 'Delete':
        if (state.cursor >= state.buffer.length) return { state, effects: [] };
        return {
          state: {
            ...state,
            buffer: state.buffer.slice(0, state.cursor) + state.buffer.slice(state.cursor + 1),
          },
          effects: [],
        };
      case 'Left':
        return {
          state: { ...state, cursor: Math.max(0, state.cursor - 1) },
          effects: [],
        };
      case 'Right':
        return {
          state: { ...state, cursor: Math.min(state.buffer.length, state.cursor + 1) },
          effects: [],
        };
      case 'Home':
        return { state: { ...state, cursor: 0 }, effects: [] };
      case 'End':
        return { state: { ...state, cursor: state.buffer.length }, effects: [] };
      case 'WordLeft':
        return {
          state: { ...state, cursor: prevWordBoundary(state.buffer, state.cursor) },
          effects: [],
        };
      case 'WordRight':
        return {
          state: { ...state, cursor: nextWordBoundary(state.buffer, state.cursor) },
          effects: [],
        };
      case 'WordBackspace': {
        const start = prevWordBoundary(state.buffer, state.cursor);
        return {
          state: {
            ...state,
            buffer: state.buffer.slice(0, start) + state.buffer.slice(state.cursor),
            cursor: start,
            candidates: [],
          },
          effects: [],
        };
      }
      case 'LineStartBackspace':
        return {
          state: {
            ...state,
            buffer: state.buffer.slice(state.cursor),
            cursor: 0,
            candidates: [],
          },
          effects: [],
        };
      case 'LineEndDelete':
        return {
          state: { ...state, buffer: state.buffer.slice(0, state.cursor), candidates: [] },
          effects: [],
        };
      case 'Up':
        return historyUp(state);
      case 'Down':
        return historyDown(state);
      case 'CtrlC':
        // Abort current line
        return {
          state: { ...state, buffer: '', cursor: 0, cmdIndex: -1, savedBuffer: '' },
          effects: [],
        };
      case 'CtrlL':
        return { state: { ...state, history: [] }, effects: [] };
      default:
        return { state, effects: [] };
    }
  }

  if (key.text !== undefined) {
    const buf = state.buffer.slice(0, state.cursor) + key.text + state.buffer.slice(state.cursor);
    return {
      state: {
        ...state,
        buffer: buf,
        cursor: state.cursor + key.text.length,
        candidates: [],
      },
      effects: [],
    };
  }

  return { state, effects: [] };
}

function handleInteractiveKey(state: TerminalState, key: KeySpec): ReduceResult {
  if (state.active === null) return { state, effects: [] };

  const session = state.active;

  // Esc / Ctrl-C: give the widget a chance to consume the key first so it
  // can back out of a sub-state (e.g. the filter mode in selectable-list)
  // without canceling the whole interaction. If the widget reports no
  // state change, fall through to canceling the entire turn.
  if (key.special === 'Escape' || key.special === 'CtrlC') {
    const probe = session.widget.handleKey(session.state, key);
    if (probe.kind === 'state' && probe.next !== session.state) {
      return {
        state: { ...state, active: { widget: session.widget, state: probe.next } },
        effects: [],
      };
    }
    if (probe.kind === 'cancel') {
      return handleExitInteractive(state, 'cancel');
    }
    return handleExitInteractive(state, 'cancel');
  }

  const step = session.widget.handleKey(session.state, key);
  switch (step.kind) {
    case 'state':
      return {
        state: {
          ...state,
          active: { widget: session.widget, state: step.next },
        },
        effects: [],
      };
    case 'cancel':
      return handleExitInteractive(state, 'cancel');
    case 'submit': {
      const resolution =
        session.widget.commit !== undefined
          ? session.widget.commit(step.result)
          : { kind: 'noop' as const };
      if (resolution.kind === 'canceled') {
        // Treat as Esc-cancel — drop the prompt + any history of this turn,
        // surface a single "canceled" line.
        const trimmed = trimToLastPrompt(state.history);
        const out: HistoryEntry = {
          kind: 'output',
          id: idFor(state),
          body: 'canceled',
          status: 'info',
        };
        return {
          state: {
            ...state,
            phase: 'idle',
            active: null,
            history: [...trimmed, out],
            nextId: state.nextId + 1,
          },
          effects: [],
        };
      }
      // Snapshot the widget into history first
      const frozen: HistoryEntry = {
        kind: 'frozen',
        id: idFor(state),
        title: session.widget.title,
        body: session.widget.snapshot(session.state),
        status: 'ok',
      };
      return {
        state: {
          ...state,
          phase: 'idle',
          active: null,
          history: [...state.history, frozen],
          nextId: state.nextId + 1,
        },
        effects: [{ kind: 'commitWidget', resolution }],
      };
    }
    default:
      return { state, effects: [] };
  }
}

function handleExitInteractive(state: TerminalState, reason: 'cancel' | 'commit'): ReduceResult {
  if (state.active === null) {
    return { state: { ...state, phase: 'idle' }, effects: [] };
  }
  if (reason === 'cancel') {
    // Hide the original prompt + any in-flight history of the interaction;
    // collapse to a single "canceled" output entry.
    const trimmed = trimToLastPrompt(state.history);
    const out: HistoryEntry = {
      kind: 'output',
      id: idFor(state),
      body: 'canceled',
      status: 'info',
    };
    return {
      state: {
        ...state,
        phase: 'idle',
        active: null,
        history: [...trimmed, out],
        nextId: state.nextId + 1,
      },
      effects: [],
    };
  }
  const session = state.active;
  const frozen: HistoryEntry = {
    kind: 'frozen',
    id: idFor(state),
    title: session.widget.title,
    body: session.widget.snapshot(session.state),
    status: 'ok',
  };
  return {
    state: {
      ...state,
      phase: 'idle',
      active: null,
      history: [...state.history, frozen],
      nextId: state.nextId + 1,
    },
    effects: [],
  };
}

function trimToLastPrompt(history: readonly HistoryEntry[]): readonly HistoryEntry[] {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]?.kind === 'prompt') {
      return history.slice(0, i);
    }
  }
  return history;
}

/* ---------- submit / result / cancel ---------- */

function handleSubmit(state: TerminalState, raw: string): ReduceResult {
  const line = raw.trim();
  if (line.length === 0) {
    // Empty line — just emit a fresh prompt
    return {
      state: { ...state, buffer: '', cursor: 0, cmdIndex: -1, savedBuffer: '' },
      effects: [],
    };
  }
  const promptEntry: HistoryEntry = {
    kind: 'prompt',
    id: idFor(state),
    text: line,
  };
  const cmdHistory = pushCmdHistory(state.cmdHistory, line);
  const effects: readonly Effect[] = [{ kind: 'runCommand', line }];
  return {
    state: {
      ...state,
      phase: 'running',
      buffer: '',
      cursor: 0,
      cmdIndex: -1,
      savedBuffer: '',
      cmdHistory,
      history: [...state.history, promptEntry],
      nextId: state.nextId + 1,
    },
    effects,
  };
}

function handleResult(
  state: TerminalState,
  entry: { readonly body: string; readonly status: 'ok' | 'err' | 'cached' | 'info' },
): ReduceResult {
  const out: HistoryEntry = {
    kind: 'output',
    id: idFor(state),
    body: entry.body,
    status: entry.status,
  };
  return {
    state: {
      ...state,
      phase: 'idle',
      history: [...state.history, out],
      nextId: state.nextId + 1,
    },
    effects: [],
  };
}

function handleCancel(state: TerminalState): ReduceResult {
  if (state.phase === 'running') {
    return { state: { ...state, phase: 'cancelling' }, effects: [{ kind: 'abort' }] };
  }
  if (state.phase === 'interactive') {
    return handleExitInteractive(state, 'cancel');
  }
  return { state, effects: [] };
}

/* ---------- cmd history navigation ---------- */

function historyUp(state: TerminalState): ReduceResult {
  if (state.cmdHistory.length === 0) return { state, effects: [] };
  const next = state.cmdIndex < 0 ? state.cmdHistory.length - 1 : Math.max(0, state.cmdIndex - 1);
  const line = state.cmdHistory[next] ?? '';
  return {
    state: {
      ...state,
      cmdIndex: next,
      savedBuffer: state.cmdIndex < 0 ? state.buffer : state.savedBuffer,
      buffer: line,
      cursor: line.length,
    },
    effects: [],
  };
}

function historyDown(state: TerminalState): ReduceResult {
  if (state.cmdIndex < 0) return { state, effects: [] };
  const next = state.cmdIndex + 1;
  if (next >= state.cmdHistory.length) {
    return {
      state: {
        ...state,
        cmdIndex: -1,
        buffer: state.savedBuffer,
        cursor: state.savedBuffer.length,
        savedBuffer: '',
      },
      effects: [],
    };
  }
  const line = state.cmdHistory[next] ?? '';
  return {
    state: { ...state, cmdIndex: next, buffer: line, cursor: line.length },
    effects: [],
  };
}

function pushCmdHistory(prev: readonly string[], line: string): readonly string[] {
  const last = prev[prev.length - 1];
  if (last === line) return prev;
  const next = [...prev, line];
  if (next.length > MAX_CMD_HISTORY) next.splice(0, next.length - MAX_CMD_HISTORY);
  return next;
}

function idFor(state: TerminalState): string {
  return `e${String(state.nextId)}`;
}

function isWordChar(ch: string): boolean {
  // Treat letters / digits / CJK as word characters; spaces & punctuation
  // act as boundaries. The CJK range covers common ideographs.
  return /[\p{L}\p{N}_]/u.test(ch);
}

/** Position to the LEFT after consuming one whitespace run + one word run. */
export function prevWordBoundary(buffer: string, cursor: number): number {
  let i = cursor;
  // Skip trailing non-word chars (whitespace / punctuation).
  while (i > 0 && !isWordChar(buffer[i - 1] ?? '')) i -= 1;
  // Skip the word itself.
  while (i > 0 && isWordChar(buffer[i - 1] ?? '')) i -= 1;
  return i;
}

/** Position to the RIGHT after consuming one word run + one whitespace run. */
export function nextWordBoundary(buffer: string, cursor: number): number {
  let i = cursor;
  while (i < buffer.length && !isWordChar(buffer[i] ?? '')) i += 1;
  while (i < buffer.length && isWordChar(buffer[i] ?? '')) i += 1;
  return i;
}

export { initialState };
