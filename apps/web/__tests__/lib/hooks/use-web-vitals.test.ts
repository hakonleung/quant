/**
 * Hook-side test for `useWebVitals` + the underlying web-vitals
 * singleton store.
 *
 * The hook now reads from a module-level store seeded by
 * `startWebVitals()` (booted at app root in `Providers`). The
 * `web-vitals` package is mocked so we can drive each metric channel
 * independently and assert that the store (a) starts empty, (b)
 * routes each channel into the matching field, (c) normalises the
 * rating string into the local union (defaulting unknown values to
 * `'poor'`), and (d) fans the snapshot out to subscribed components.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

beforeEach(async () => {
  const { startWebVitals, __resetWebVitalsForTest } = await import(
    '../../../lib/web-vitals/store.js'
  );
  __resetWebVitalsForTest();
  lcpCbs.length = 0;
  inpCbs.length = 0;
  clsCbs.length = 0;
  startWebVitals();
});

afterEach(async () => {
  const { __resetWebVitalsForTest } = await import('../../../lib/web-vitals/store.js');
  __resetWebVitalsForTest();
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

  it('fans the same snapshot to multiple subscribers', async () => {
    const { useWebVitals } = await import('../../../lib/hooks/use-web-vitals.js');
    const a = renderHook(() => useWebVitals());
    const b = renderHook(() => useWebVitals());
    act(() => {
      lcpCbs[0]?.(metric('LCP', 1800, 'good'));
    });
    expect(a.result.current.lcp).toEqual({ value: 1800, rating: 'good' });
    expect(b.result.current.lcp).toEqual({ value: 1800, rating: 'good' });
  });

  it('startWebVitals is idempotent — re-calling does not re-register listeners', async () => {
    const { startWebVitals } = await import('../../../lib/web-vitals/store.js');
    startWebVitals();
    startWebVitals();
    // Only the single registration from beforeEach should exist.
    expect(lcpCbs.length).toBe(1);
    expect(inpCbs.length).toBe(1);
    expect(clsCbs.length).toBe(1);
  });
});
