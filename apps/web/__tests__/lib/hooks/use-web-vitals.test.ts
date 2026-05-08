/**
 * Hook-side test for `useWebVitals`.
 *
 * web-vitals callbacks are mocked so we can drive each metric channel
 * independently and assert that the hook (a) starts in the empty
 * state, (b) routes each channel into the matching field, and (c)
 * normalises the rating string into the local union (defaulting
 * unknown values to `'poor'` so a future library widening can't sneak
 * an invalid colour through `vitalColor`).
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Metric } from 'web-vitals';

type Callback = (m: Metric) => void;

const lcpCbs: Callback[] = [];
const inpCbs: Callback[] = [];
const clsCbs: Callback[] = [];

vi.mock('web-vitals', () => ({
  onLCP: (cb: Callback): void => {
    lcpCbs.push(cb);
  },
  onINP: (cb: Callback): void => {
    inpCbs.push(cb);
  },
  onCLS: (cb: Callback): void => {
    clsCbs.push(cb);
  },
}));

afterEach(() => {
  lcpCbs.length = 0;
  inpCbs.length = 0;
  clsCbs.length = 0;
});

function metric(name: string, value: number, rating: string): Metric {
  return { name, value, rating } as unknown as Metric;
}

describe('useWebVitals', () => {
  it('starts with all three channels null', async () => {
    const { useWebVitals } = await import('../../../lib/hooks/use-web-vitals.js');
    const { result } = renderHook(() => useWebVitals());
    expect(result.current).toEqual({ lcp: null, inp: null, cls: null });
  });

  it('routes onLCP samples into the lcp slot', async () => {
    const { useWebVitals } = await import('../../../lib/hooks/use-web-vitals.js');
    const { result } = renderHook(() => useWebVitals());
    act(() => {
      lcpCbs[0]?.(metric('LCP', 2400, 'good'));
    });
    expect(result.current.lcp).toEqual({ value: 2400, rating: 'good' });
    expect(result.current.inp).toBeNull();
    expect(result.current.cls).toBeNull();
  });

  it('routes onINP samples into the inp slot', async () => {
    const { useWebVitals } = await import('../../../lib/hooks/use-web-vitals.js');
    const { result } = renderHook(() => useWebVitals());
    act(() => {
      inpCbs[0]?.(metric('INP', 180, 'good'));
    });
    expect(result.current.inp).toEqual({ value: 180, rating: 'good' });
  });

  it('routes onCLS samples into the cls slot', async () => {
    const { useWebVitals } = await import('../../../lib/hooks/use-web-vitals.js');
    const { result } = renderHook(() => useWebVitals());
    act(() => {
      clsCbs[0]?.(metric('CLS', 0.07, 'good'));
    });
    expect(result.current.cls).toEqual({ value: 0.07, rating: 'good' });
  });

  it('preserves rating buckets for needs-improvement', async () => {
    const { useWebVitals } = await import('../../../lib/hooks/use-web-vitals.js');
    const { result } = renderHook(() => useWebVitals());
    act(() => {
      lcpCbs[0]?.(metric('LCP', 3000, 'needs-improvement'));
    });
    expect(result.current.lcp?.rating).toBe('needs-improvement');
  });

  it('preserves rating buckets for poor', async () => {
    const { useWebVitals } = await import('../../../lib/hooks/use-web-vitals.js');
    const { result } = renderHook(() => useWebVitals());
    act(() => {
      lcpCbs[0]?.(metric('LCP', 5000, 'poor'));
    });
    expect(result.current.lcp?.rating).toBe('poor');
  });

  it('falls back to poor when rating is an unknown string', async () => {
    const { useWebVitals } = await import('../../../lib/hooks/use-web-vitals.js');
    const { result } = renderHook(() => useWebVitals());
    act(() => {
      lcpCbs[0]?.(metric('LCP', 9999, 'mystery'));
    });
    expect(result.current.lcp?.rating).toBe('poor');
  });

  it('overwrites the previous sample on later callbacks', async () => {
    const { useWebVitals } = await import('../../../lib/hooks/use-web-vitals.js');
    const { result } = renderHook(() => useWebVitals());
    act(() => {
      inpCbs[0]?.(metric('INP', 120, 'good'));
    });
    act(() => {
      inpCbs[0]?.(metric('INP', 480, 'needs-improvement'));
    });
    expect(result.current.inp).toEqual({ value: 480, rating: 'needs-improvement' });
  });

  it('ignores callbacks fired after unmount', async () => {
    const { useWebVitals } = await import('../../../lib/hooks/use-web-vitals.js');
    const { result, unmount } = renderHook(() => useWebVitals());
    unmount();
    // The "mounted" flag should swallow the late update; vitest will
    // complain if we'd called setState on an unmounted node.
    act(() => {
      lcpCbs[0]?.(metric('LCP', 2200, 'good'));
    });
    expect(result.current.lcp).toBeNull();
  });
});
