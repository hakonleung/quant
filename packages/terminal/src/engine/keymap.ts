/**
 * Standardized key spec used everywhere downstream of xterm.js.
 *
 * xterm emits `onData(string)` for each key sequence. We normalize those byte
 * sequences into a `KeySpec` that downstream reducers / widgets can reason
 * about deterministically. Pure module — no IO (CLAUDE.md §2.5.1).
 */

export type SpecialKey =
  | 'Enter'
  | 'Escape'
  | 'Tab'
  | 'ShiftTab'
  | 'Backspace'
  | 'Delete'
  | 'Up'
  | 'Down'
  | 'Left'
  | 'Right'
  | 'Home'
  | 'End'
  | 'PageUp'
  | 'PageDown'
  | 'CtrlC'
  | 'CtrlL'
  | 'CtrlD'
  | 'CtrlEnter'
  /** Cursor jumps a word to the left (Option/Alt + ←, or Ctrl+Left). */
  | 'WordLeft'
  /** Cursor jumps a word to the right (Option/Alt + →, or Ctrl+Right). */
  | 'WordRight'
  /** Delete word to the left of cursor (Option+Backspace, or Ctrl+W). */
  | 'WordBackspace'
  /** Delete from cursor to start of line (Cmd+Backspace, or Ctrl+U). */
  | 'LineStartBackspace'
  /** Delete from cursor to end of line (Ctrl+K). */
  | 'LineEndDelete';

export interface KeySpec {
  /** A `SpecialKey` symbol when recognized; otherwise undefined. */
  readonly special?: SpecialKey;
  /** Raw printable text (single grapheme or paste chunk). */
  readonly text?: string;
}

/**
 * Translate one `xterm.onData` chunk to a {@link KeySpec}. Long paste chunks
 * map to a single `text` spec so widgets can detect "user pasted multiple
 * lines" without having to coalesce per-byte events themselves.
 */
export function toKeySpec(data: string): KeySpec {
  if (data.length === 0) return {};

  // Multi-character chunk that does NOT start with ESC = paste.
  if (data.length > 1 && data.charCodeAt(0) !== 0x1b) {
    return { text: data };
  }

  switch (data) {
    case '\r':
    case '\n':
      return { special: 'Enter' };
    case '\x1b':
      return { special: 'Escape' };
    case '\x7f':
    case '\b':
      return { special: 'Backspace' };
    case '\t':
      return { special: 'Tab' };
    case '\x1b[Z':
      return { special: 'ShiftTab' };
    case '\x1b[A':
      return { special: 'Up' };
    case '\x1b[B':
      return { special: 'Down' };
    case '\x1b[C':
      return { special: 'Right' };
    case '\x1b[D':
      return { special: 'Left' };
    case '\x1b[H':
    case '\x1bOH':
      return { special: 'Home' };
    case '\x1b[F':
    case '\x1bOF':
      return { special: 'End' };
    case '\x1b[5~':
      return { special: 'PageUp' };
    case '\x1b[6~':
      return { special: 'PageDown' };
    case '\x1b[3~':
      return { special: 'Delete' };
    case '\x03':
      return { special: 'CtrlC' };
    case '\x0c':
      return { special: 'CtrlL' };
    case '\x04':
      return { special: 'CtrlD' };
    // Emacs-style line / word editing.
    case '\x01': // Ctrl+A
      return { special: 'Home' };
    case '\x05': // Ctrl+E
      return { special: 'End' };
    case '\x15': // Ctrl+U
      return { special: 'LineStartBackspace' };
    case '\x0b': // Ctrl+K
      return { special: 'LineEndDelete' };
    case '\x17': // Ctrl+W
      return { special: 'WordBackspace' };
    case '\x1bb': // Alt+b
      return { special: 'WordLeft' };
    case '\x1bf': // Alt+f
      return { special: 'WordRight' };
    case '\x1b\x7f': // Alt+Backspace
    case '\x1b\b':
      return { special: 'WordBackspace' };
    // Ctrl + Arrow (some terminals): word jump.
    case '\x1b[1;5D':
    case '\x1b[5D':
      return { special: 'WordLeft' };
    case '\x1b[1;5C':
    case '\x1b[5C':
      return { special: 'WordRight' };
    // Ctrl+Enter — varies by terminal; xterm emits LF (0x0a) for vanilla,
    // and many emulators emit ESC+CR. We treat both LF and ESC-Enter as
    // CtrlEnter so multi-line widgets can submit on Ctrl+Enter.
    case '\x1b\r':
      return { special: 'CtrlEnter' };
    default: {
      // Reject any other ESC-prefixed unknown sequence; treat as Escape.
      if (data.charCodeAt(0) === 0x1b) return { special: 'Escape' };
      // Single printable codepoint
      const cc = data.charCodeAt(0);
      if (cc < 0x20) return {};
      return { text: data };
    }
  }
}

export function describe(key: KeySpec): string {
  if (key.special !== undefined) return key.special;
  if (key.text !== undefined) return JSON.stringify(key.text);
  return '<empty>';
}

/**
 * Translate a browser-level `KeyboardEvent` (intercepted via xterm's
 * `attachCustomKeyEventHandler`) into a `KeySpec` for shortcuts that
 * browsers swallow before xterm sees them — Cmd/Meta + arrows on macOS,
 * Alt + arrows on every platform, etc.
 *
 * Returns `null` when the event isn't one of the captured shortcuts; the
 * caller should let xterm handle it normally.
 */
export function fromBrowserEvent(ev: KeyboardEvent): KeySpec | null {
  if (ev.type !== 'keydown') return null;
  const meta = ev.metaKey;
  const alt = ev.altKey;
  const ctrl = ev.ctrlKey;
  const k = ev.key;

  // Meta/Cmd + Arrow (macOS line jumps)
  if (meta && !alt && !ctrl) {
    if (k === 'ArrowLeft') return { special: 'Home' };
    if (k === 'ArrowRight') return { special: 'End' };
    if (k === 'Backspace') return { special: 'LineStartBackspace' };
    if (k === 'Delete') return { special: 'LineEndDelete' };
  }
  // Alt/Option + Arrow (word jumps)
  if (alt && !meta && !ctrl) {
    if (k === 'ArrowLeft') return { special: 'WordLeft' };
    if (k === 'ArrowRight') return { special: 'WordRight' };
    if (k === 'Backspace') return { special: 'WordBackspace' };
  }
  // Ctrl + Arrow on Windows / Linux: word jump.
  if (ctrl && !alt && !meta) {
    if (k === 'ArrowLeft') return { special: 'WordLeft' };
    if (k === 'ArrowRight') return { special: 'WordRight' };
  }
  return null;
}
