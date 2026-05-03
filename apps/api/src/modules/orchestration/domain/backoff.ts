/**
 * Exponential backoff with jitter (modules/09-update-orchestration.md §5.2).
 *
 * Pure: takes the attempt number, returns a delay in ms. Jitter source
 * is injected for testability.
 */

export interface BackoffOptions {
  readonly baseMs: number;
  readonly factor: number;
  readonly maxMs: number;
  readonly jitterRatio: number;
  /** [0, 1) random source. Defaults to `Math.random`. */
  readonly random?: () => number;
}

export class ExponentialBackoff {
  constructor(private readonly options: BackoffOptions) {
    if (options.baseMs < 0) throw new Error('baseMs must be >= 0');
    if (options.factor < 1) throw new Error('factor must be >= 1');
    if (options.maxMs < options.baseMs) throw new Error('maxMs must be >= baseMs');
    if (options.jitterRatio < 0 || options.jitterRatio > 1) {
      throw new Error('jitterRatio must be in [0, 1]');
    }
  }

  /** Compute delay for `attempt` (1-indexed). */
  next(attempt: number): number {
    const exp = this.options.baseMs * Math.pow(this.options.factor, Math.max(0, attempt - 1));
    const capped = Math.min(this.options.maxMs, exp);
    const random = this.options.random ?? Math.random;
    const jitter = capped * this.options.jitterRatio * (random() * 2 - 1);
    return Math.max(0, Math.round(capped + jitter));
  }
}
