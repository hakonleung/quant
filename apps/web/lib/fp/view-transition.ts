/**
 * Wrapper around `document.startViewTransition` that gracefully falls
 * back to a synchronous call when the browser doesn't support the View
 * Transition API (Firefox, older Safari, SSR). The fallback path keeps
 * the same observable side effect — `mutate` runs once — so callers
 * never need to branch.
 *
 * Pure (CLAUDE.md §2.5.1): the function relies only on the `document`
 * argument it's given; callers provide it so SSR / tests can pass null
 * to force the no-API path without touching the global.
 */

interface ViewTransitionDoc {
  readonly startViewTransition?: (cb: () => void) => unknown;
}

export function runViewTransition(
  doc: ViewTransitionDoc | null | undefined,
  mutate: () => void,
): void {
  const start = doc?.startViewTransition;
  if (typeof start === 'function') {
    start.call(doc, mutate);
    return;
  }
  mutate();
}
