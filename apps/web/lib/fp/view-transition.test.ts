import { describe, expect, it, vi } from 'vitest';

import { runViewTransition } from './view-transition.js';

describe('runViewTransition', () => {
  it('runs the mutate fn synchronously when the API is unavailable', () => {
    const mutate = vi.fn();
    runViewTransition(null, mutate);
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('falls back synchronously when document is undefined', () => {
    const mutate = vi.fn();
    runViewTransition(undefined, mutate);
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('forwards mutate to startViewTransition when supported', () => {
    const mutate = vi.fn();
    const startViewTransition = vi.fn((cb: () => void) => {
      cb();
      return { ready: Promise.resolve() };
    });
    runViewTransition({ startViewTransition }, mutate);
    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('does not call mutate twice when startViewTransition exists', () => {
    const mutate = vi.fn();
    // The implementation MUST NOT also call mutate() after delegating —
    // otherwise the mutation happens twice. Here we record but never
    // invoke the callback, so a fallback path would surface as a fail.
    const startViewTransition = vi.fn(() => ({}));
    runViewTransition({ startViewTransition }, mutate);
    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(mutate).not.toHaveBeenCalled();
  });
});
