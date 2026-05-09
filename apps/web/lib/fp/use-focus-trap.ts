'use client';

/**
 * Focus-trap helper for modal-like dialogs.
 *
 * - When `active` flips to true, the previously focused element is
 *   remembered, and focus moves to the first focusable element inside
 *   the container (or the container itself).
 * - Tab / Shift+Tab inside the container wraps around the first/last
 *   focusable element so the user can't accidentally tab back into the
 *   page underneath.
 * - When `active` flips back to false, focus restores to the element
 *   that had it before the modal opened.
 *
 * `Esc` is **not** wired here — that's a UX-level decision (should it
 * cancel? save?). Callers add their own `keydown` listener.
 *
 * Used by `LedgerAddForm` (and reusable by the future command palette
 * / notify center). Pure DOM helper, no Chakra / framework lock-in.
 */

import { useEffect, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function focusableElements(root: HTMLElement): readonly HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

/** Type-guard read of `document.activeElement` — only returns the
 *  node when it is actually an `HTMLElement`, so callers don't have to
 *  reason about SVG / null cases on every focus restore. */
function readActiveElement(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const el = document.activeElement;
  return el instanceof HTMLElement ? el : null;
}

export function useFocusTrap(containerRef: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (container === null) return;
    const previous = readActiveElement();
    const focusables = focusableElements(container);
    // Prefer the first focusable child; fall back to the container so
    // screen readers still announce the dialog when there's no input.
    if (focusables.length > 0) {
      focusables[0]?.focus();
    } else if (typeof container.focus === 'function') {
      container.focus();
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab') return;
      const current = focusableElements(container);
      if (current.length === 0) {
        e.preventDefault();
        return;
      }
      const first = current[0];
      const last = current[current.length - 1];
      if (first === undefined || last === undefined) return;
      const active2 = document.activeElement;
      if (e.shiftKey && active2 === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active2 === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (previous !== null) previous.focus();
    };
  }, [active, containerRef]);
}
