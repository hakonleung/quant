/**
 * `Clock` port + `SystemClock` adapter (CLAUDE.md §2.6 — no implicit
 * time/randomness in business code).
 *
 * Mirrors the Python-side `quant_core.ports.clock.Clock` so the two
 * codebases share the same vocabulary. Services that need a wall-clock
 * time inject this via the `CLOCK` token; tests inject a `FrozenClock`.
 */

import type { Provider } from '@nestjs/common';

export const CLOCK = Symbol('CLOCK');

export interface Clock {
  /** Current wall-clock time. */
  now(): Date;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

export const SYSTEM_CLOCK_PROVIDER: Provider = {
  provide: CLOCK,
  useClass: SystemClock,
};

/** Test helper — returns a fixed instant on every call to `now()`. */
export class FrozenClock implements Clock {
  constructor(private readonly instant: Date) {}
  now(): Date {
    return new Date(this.instant.getTime());
  }
}
