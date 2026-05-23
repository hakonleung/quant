/**
 * Vim-style sequence keymap engine — pure controller.
 *
 * Decoupled from `window` so it can be unit-tested without jsdom side
 * effects. The React wrapper (`install.tsx`) attaches a single keydown
 * listener and forwards events through `handle()`.
 *
 * Decisions (see `docs/rfcs/0004-ui-cmd-keyboard-engine.md` §9):
 *   - 1200ms leader timeout.
 *   - Editable-target skip rule (opt-out via `data-allow-hotkeys="true"`).
 *   - `?` always opens hint window.
 *   - `Esc` priority: exit fullscreen → clear buffer → close modal.
 */

import { matchSequence } from '../pure/match.js';
import { normalizeEvent } from '../pure/parse-keys.js';
import {
  CLOSE_MODAL_CELL_ID,
  EXIT_FULLSCREEN_CELL_ID,
  HINT_TOGGLE_CELL_ID,
  type KeySequence,
  type KeyToken,
  type UiBinding,
  type UiCtx,
} from '../types.js';

export const DEFAULT_SEQ_TIMEOUT_MS = 1200;

export interface KeymapEngineDeps {
  /** Returns the current UI context — read on every keystroke. */
  getCtx(): UiCtx;
  /** Returns the bindings visible under the current context. */
  getBindings(): readonly UiBinding[];
  /** Dispatches a cell by id (typically backed by `uiRegistry.dispatch`). */
  dispatch(cellId: string, args?: unknown): Promise<void> | void;
  /** Wall clock used for timeout — injectable for tests. */
  now?(): number;
  /** Sequence timeout in ms. Defaults to 1200. */
  timeoutMs?: number;
  /** Called whenever the engine swallows an event (for telemetry/tests). */
  onSwallow?(reason: 'editable' | 'sequence' | 'special'): void;
}

export interface KeymapEngine {
  handle(event: KeyboardEvent): void;
  /** Currently pending tokens — exposed for tests + hint window. */
  buffer(): KeySequence;
  cancel(): void;
}

export function createKeymapEngine(deps: KeymapEngineDeps): KeymapEngine {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_SEQ_TIMEOUT_MS;
  const now = deps.now ?? Date.now;
  let buffer: KeyToken[] = [];
  let lastKeyAt = 0;

  function reset(): void {
    buffer = [];
    lastKeyAt = 0;
  }

  function applyTimeout(): void {
    if (buffer.length === 0) return;
    if (now() - lastKeyAt >= timeoutMs) reset();
  }

  function handle(event: KeyboardEvent): void {
    applyTimeout();
    const token = normalizeEvent(event);
    if (token === null) return;

    const ctx = deps.getCtx();

    // `?` is always the hint toggle — but only when not typing in a field
    // (the skip rule below still applies for `?` too).
    if (token === '?' && !isEditableTarget(event.target)) {
      event.preventDefault();
      reset();
      void deps.dispatch(HINT_TOGGLE_CELL_ID);
      return;
    }

    if (token === 'Esc') {
      event.preventDefault();
      if (ctx.hintOpen) {
        void deps.dispatch(HINT_TOGGLE_CELL_ID);
        return;
      }
      if (ctx.fullscreen !== null) {
        void deps.dispatch(EXIT_FULLSCREEN_CELL_ID);
        return;
      }
      if (buffer.length > 0) {
        reset();
        deps.onSwallow?.('sequence');
        return;
      }
      if (ctx.modalOpen) {
        void deps.dispatch(CLOSE_MODAL_CELL_ID);
        return;
      }
      return;
    }

    if (isEditableTarget(event.target)) {
      deps.onSwallow?.('editable');
      return;
    }

    buffer.push(token);
    lastKeyAt = now();
    const bindings = deps.getBindings();
    const result = matchSequence(buffer, bindings, ctx);

    if (result.kind === 'exact') {
      event.preventDefault();
      const cellId = result.cellId;
      reset();
      void deps.dispatch(cellId);
      return;
    }
    if (result.kind === 'partial') {
      event.preventDefault();
      return;
    }
    // No match: if the buffer was a single key, swallow silently;
    // otherwise reset and let the next key start fresh.
    if (buffer.length > 1) {
      reset();
      deps.onSwallow?.('sequence');
      event.preventDefault();
    } else {
      reset();
    }
  }

  return {
    handle,
    buffer: () => buffer.slice(),
    cancel: reset,
  };
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (target === null) return false;
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest('[data-allow-hotkeys="true"]') !== null) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}
