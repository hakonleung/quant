'use client';

/**
 * React adapter over the module-level web-vitals singleton (see
 * `lib/web-vitals/store.ts`). The actual subscription is bootstrapped
 * once at app root by `<WebVitalsBoot/>` in `Providers`, so by the
 * time any feature pane reads from this hook the listeners are
 * already registered — crucial because `web-vitals` stops collecting
 * LCP/CLS after first input.
 */

import { useSyncExternalStore } from 'react';

import {
  getWebVitalsServerSnapshot,
  getWebVitalsSnapshot,
  subscribeWebVitals,
} from '../web-vitals/store.js';

export type { VitalRating, VitalSample, WebVitals } from '../web-vitals/store.js';
import type { WebVitals } from '../web-vitals/store.js';

export function useWebVitals(): WebVitals {
  return useSyncExternalStore(
    subscribeWebVitals,
    getWebVitalsSnapshot,
    getWebVitalsServerSnapshot,
  );
}
