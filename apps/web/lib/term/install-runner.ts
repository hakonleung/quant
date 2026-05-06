'use client';

/**
 * Picks the active terminal action runner at app boot and installs it
 * via `@quant/terminal`'s `_setRunner()`. The terminal package itself
 * stays free of HTTP code; here we choose between:
 *
 *   - `LiveActionRunner`  → real `/api/...` BFF calls (default)
 *   - `MockActionRunner`  → fixtures (no network)
 *
 * Toggle priority (high → low):
 *   1. `localStorage['tm.runner']`            ← per-user, persists
 *   2. `process.env.NEXT_PUBLIC_TM_RUNNER`    ← per-environment
 *   3. fallback                               ← `'live'`
 *
 * Setting `localStorage.tm.runner = 'mock'` in the dev console flips
 * the next page load back to fixtures — useful for isolation testing
 * without touching code.
 */

import { _setRunner, MockActionRunner } from '@quant/terminal';
import type { QueryClient } from '@tanstack/react-query';

import { LiveActionRunner, type LiveRunnerDeps } from './live-runner.js';
import { createRevalidate } from './revalidate.js';

export type RunnerKind = 'live' | 'mock';

const STORAGE_KEY = 'tm.runner';

/**
 * Read the configured runner kind. Safe to call on the server — falls
 * back to `'live'` if `localStorage` is unavailable.
 */
export function readRunnerKind(): RunnerKind {
  // 1. localStorage
  if (typeof globalThis !== 'undefined' && typeof localStorage !== 'undefined') {
    try {
      const v = localStorage.getItem(STORAGE_KEY);
      if (v === 'mock' || v === 'live') return v;
    } catch {
      /* sandboxed contexts throw — ignore */
    }
  }
  // 2. NEXT_PUBLIC_TM_RUNNER
  const env = process.env['NEXT_PUBLIC_TM_RUNNER'];
  if (env === 'mock' || env === 'live') return env;
  // 3. fallback
  return 'live';
}

export interface InstallOptions {
  /** Required for live mode — used to lookup names / wire revalidation. */
  readonly lookupName: LiveRunnerDeps['lookupName'];
  /** Required for live mode — drives cross-cache invalidation. */
  readonly queryClient: QueryClient;
}

/**
 * Install the chosen runner globally. Call before the bridge mounts —
 * the easiest place is the top of `useTerminal.mount`. Re-installing
 * is safe (the previous instance is GC'd).
 *
 * Returns the runner's `kind` AND a ready-made `revalidate` function
 * — the bridge uses both: the function is also passed to
 * {@link CommandStores.revalidate} so commands like `update` can
 * trigger refreshes directly.
 */
export function installRunner(opts: InstallOptions): {
  readonly kind: RunnerKind;
  readonly revalidate: ReturnType<typeof createRevalidate>;
} {
  const kind = readRunnerKind();
  const revalidate = createRevalidate(opts.queryClient);
  if (kind === 'mock') {
    _setRunner(new MockActionRunner());
  } else {
    _setRunner(
      new LiveActionRunner({
        lookupName: opts.lookupName,
        revalidate,
      }),
    );
  }
  return { kind, revalidate };
}
