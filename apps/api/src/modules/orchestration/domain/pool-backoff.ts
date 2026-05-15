/**
 * Pool-level backoff (modules/09-update-orchestration.md §6).
 *
 * Models the queue-engine "lock the pool, drain in-flight, wait
 * cooldown, then resume" cycle. Independent of the per-task
 * {@link ExponentialBackoff} — pool-class errors (connection abort,
 * http proxy outages) signal that the channel itself is unhealthy, so
 * retrying any task on it before the channel recovers just wastes
 * attempts.
 *
 * State machine:
 *   healthy ──trip(err)──▶ locked (paused, draining in-flight)
 *   locked  ──drained─────▶ cooling-down (waiting cooldown window)
 *   cooling ──timer fires─▶ healthy (queue resumed)
 *
 *   reset() — first successful task after a trip; zeroes the
 *             consecutive-trip counter (next trip starts from baseMs).
 *
 * Pure: emits side-effects exclusively through the {@link PoolGate}
 * callback (queue's pause / resume / inFlight predicate). No nest, no
 * IO, fully unit-testable.
 */

import { ExponentialBackoff, type BackoffOptions } from './backoff.js';

export interface PoolBackoffOptions extends BackoffOptions {
  /** Classifier — when `true`, a worker failure trips the pool. */
  readonly isPoolError: (err: unknown) => boolean;
}

/** Hooks the controller needs to drive the pool's lifecycle. */
export interface PoolGate {
  /** Stop pulling new jobs off the waiting list. */
  pause: () => void;
  /** Number of jobs currently being processed (post-pause this counts down). */
  inFlight: () => number;
  /** Resume dispatch. */
  resume: () => void;
  /** Schedule a callback after `ms`. Defaults to `setTimeout` — injectable for tests. */
  schedule?: (ms: number, fn: () => void) => void;
  /** Poll interval (ms) while waiting for in-flight to drain. Defaults to 50. */
  drainPollMs?: number;
}

export class PoolBackoff {
  private readonly backoff: ExponentialBackoff;
  private readonly schedule: NonNullable<PoolGate['schedule']>;
  private readonly drainPollMs: number;
  private consecutiveTrips = 0;
  private locked = false;

  constructor(
    private readonly options: PoolBackoffOptions,
    private readonly gate: PoolGate,
  ) {
    this.backoff = new ExponentialBackoff(options);
    this.schedule =
      gate.schedule ??
      ((ms, fn): void => {
        setTimeout(fn, ms);
      });
    this.drainPollMs = gate.drainPollMs ?? 50;
  }

  /** Did the error classifier flag this as pool-level? */
  classify(err: unknown): boolean {
    return this.options.isPoolError(err);
  }

  /** `true` if the pool is currently locked (paused + draining + cooling). */
  get isLocked(): boolean {
    return this.locked;
  }

  /**
   * Trip the pool. Idempotent: a second trip while already locked is a
   * no-op (the in-flight job that races a trip emits one trip but the
   * pool is already paused).
   *
   * Returns the cooldown delay in ms (after drain). Useful for logging.
   */
  trip(): number {
    if (this.locked) return 0;
    this.consecutiveTrips += 1;
    const delay = this.backoff.next(this.consecutiveTrips);
    this.locked = true;
    this.gate.pause();
    this.waitForDrainThenCool(delay);
    return delay;
  }

  /** First success after a trip — reset the streak. */
  reset(): void {
    if (this.locked) return; // still cooling — don't unlock prematurely
    this.consecutiveTrips = 0;
  }

  private waitForDrainThenCool(coolMs: number): void {
    const tick = (): void => {
      if (this.gate.inFlight() <= 0) {
        this.schedule(coolMs, () => {
          this.locked = false;
          this.gate.resume();
        });
        return;
      }
      this.schedule(this.drainPollMs, tick);
    };
    tick();
  }
}
