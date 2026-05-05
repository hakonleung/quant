/**
 * Pick the active runner for the terminal. Defaults to the mock runner so
 * the entire UI works without any backend; flip to the live runner via the
 * `tm.runner` localStorage key.
 *
 * In M1 we only ship the mock runner — the live runner is added in M2.
 */

import { MockActionRunner } from './mock-runner.js';
import type { DataActionRunner } from './types.js';

let _instance: DataActionRunner | null = null;

export function getRunner(): DataActionRunner {
  if (_instance !== null) return _instance;
  _instance = new MockActionRunner();
  return _instance;
}

/** Replace the runner — only intended for tests. */
export function _setRunner(r: DataActionRunner | null): void {
  _instance = r;
}
