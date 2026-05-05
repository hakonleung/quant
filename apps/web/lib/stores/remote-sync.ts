/**
 * Glue between a Zustand store and a remote PUT endpoint.
 *
 * Replaces the IDB-backed `persist` middleware with backend persistence.
 * On boot we GET the initial state once (idempotent — multiple subscribers
 * share the same load) and seed the store. On every subsequent change to
 * the persisted slice we debounce-PUT to the backend.
 *
 * The pattern is intentionally small: stores keep their plain
 * `create()` shape and a sibling hook `useRemoteSync*` wires the load
 * + flush at the app shell. No middleware, no hidden state.
 */

'use client';

import { useEffect, useRef } from 'react';
import type { StoreApi, UseBoundStore } from 'zustand';

const DEBOUNCE_MS = 400;

interface RemoteSyncArgs<S, P> {
  readonly store: UseBoundStore<StoreApi<S>>;
  readonly load: () => Promise<P>;
  readonly apply: (payload: P) => void;
  readonly select: (state: S) => P;
  readonly equal: (a: P, b: P) => boolean;
  readonly save: (payload: P) => Promise<unknown>;
}

export function useRemoteSync<S, P>(args: RemoteSyncArgs<S, P>): void {
  const { store, load, apply, select, equal, save } = args;
  const lastSentRef = useRef<P | null>(null);
  const loadedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    void (async () => {
      try {
        const payload = await load();
        if (cancelled) return;
        lastSentRef.current = payload;
        apply(payload);
      } catch (err) {
        // Boot fetch failed — UI still works with the in-memory default.
        // eslint-disable-next-line no-console
        console.warn('remote sync boot failed', err);
      } finally {
        loadedRef.current = true;
      }
    })();

    const unsub = store.subscribe((state) => {
      if (!loadedRef.current) return;
      const next = select(state);
      const last = lastSentRef.current;
      if (last !== null && equal(last, next)) return;
      lastSentRef.current = next;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        save(next).catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.warn('remote sync save failed', err);
        });
      }, DEBOUNCE_MS);
    });

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      unsub();
    };
  }, [store, load, apply, select, equal, save]);
}

export function shallowArrayEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function jsonEqual<T>(a: T, b: T): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}
