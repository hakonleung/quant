/**
 * Token-bucket rate limiter (modules/09-update-orchestration.md §5.1).
 *
 * Pure data + a clock function. `now` is injected to keep the class
 * deterministic in tests (CLAUDE.md §2.6 — no implicit time). The
 * `Date.now` default is only used when no clock is supplied.
 */

/* eslint-disable no-restricted-globals -- Date.now is the default clock; callers may inject a deterministic source. */

export interface TokenBucketOptions {
  readonly ratePerSec: number;
  readonly burst: number;
  readonly now?: () => number;
}

export class TokenBucket {
  private readonly ratePerMs: number;
  private readonly burst: number;
  private readonly now: () => number;
  private tokens: number;
  private lastRefill: number;

  constructor(options: TokenBucketOptions) {
    if (options.ratePerSec <= 0) throw new Error('ratePerSec must be > 0');
    if (options.burst <= 0) throw new Error('burst must be > 0');
    this.ratePerMs = options.ratePerSec / 1000;
    this.burst = options.burst;
    this.now = options.now ?? ((): number => Date.now());
    this.tokens = options.burst;
    this.lastRefill = this.now();
  }

  /** Returns 0 if a token was consumed immediately, else ms to wait. */
  tryAcquireOrWaitMs(): number {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    const deficit = 1 - this.tokens;
    return Math.ceil(deficit / this.ratePerMs);
  }

  /** Block (await) until a token is available, then consume it. */
  async acquire(): Promise<void> {
    for (;;) {
      const wait = this.tryAcquireOrWaitMs();
      if (wait === 0) return;
      await new Promise<void>((resolve) => setTimeout(resolve, wait));
    }
  }

  private refill(): void {
    const now = this.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerMs);
    this.lastRefill = now;
  }
}
