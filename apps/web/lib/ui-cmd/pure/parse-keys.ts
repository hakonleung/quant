/**
 * Pure key parsing and event normalization.
 *
 * Sequence syntax: tokens separated by spaces. A token is either a
 * single character (`'a'`, `'?'`), an uppercase letter (shift+letter
 * canonical form, e.g. `'D'`), or a named key (`'Esc'`, `'Enter'`,
 * `'Tab'`, `'Space'`). The `shift+x` form is accepted on input and
 * canonicalized to `'X'`.
 */

import type { KeySequence, KeyToken } from '../types.js';

const NAMED_KEYS = new Set(['Esc', 'Enter', 'Tab', 'Space']);

/** Parse a sequence string into canonical tokens. */
export function parseSequence(raw: string): KeySequence {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  return trimmed.split(/\s+/).map(parseToken);
}

function parseToken(raw: string): KeyToken {
  if (raw.length === 1) return raw;
  if (NAMED_KEYS.has(raw)) return raw;
  const lower = raw.toLowerCase();
  if (lower.startsWith('shift+') && lower.length === 7) {
    return raw.slice(6).toUpperCase();
  }
  return raw;
}

/**
 * Normalize a browser `KeyboardEvent` to a canonical `KeyToken`. Returns
 * `null` for events the engine should ignore (modifier-only keys, key
 * repeats from holding non-printable keys, Ctrl/Alt/Meta chords — we
 * use Shift exclusively).
 */
export function normalizeEvent(e: KeyboardEvent): KeyToken | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  const key = e.key;
  if (key === 'Shift' || key === 'Control' || key === 'Alt' || key === 'Meta') {
    return null;
  }
  if (key === 'Escape') return 'Esc';
  if (key === ' ') return 'Space';
  if (NAMED_KEYS.has(key)) return key;
  if (key.length === 1) {
    return e.shiftKey ? key.toUpperCase() : key;
  }
  return null;
}

/** True if `prefix` is a strict-or-equal prefix of `seq`. */
export function isPrefixOf(prefix: KeySequence, seq: KeySequence): boolean {
  if (prefix.length > seq.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (prefix[i] !== seq[i]) return false;
  }
  return true;
}
