/**
 * Zustand `persist` storage adapter backed by IndexedDB
 * (modules/07-frontend.md §6.2 / §9).
 *
 * One DB `quant-app`, one object store per logical Zustand slice. When
 * IndexedDB is unavailable (private mode, SSR, ancient browser) the
 * adapter degrades through two tiers:
 *   1. `localStorage` when present — survives reloads but no quota
 *      banner is shown yet (TODO once the data import/export page lands)
 *   2. an in-memory `Map` as a last resort — non-persistent
 *
 * Writes are coalesced through a 75 ms tail-debounce keyed on
 * `(store, name)`. High-frequency state slices (e.g. `ui.store` is
 * touched on every focus-code keypress, `layout.store` on every drag
 * frame) used to fire one IDB transaction per setState; under the
 * debounce only the final value reaches disk. A `pagehide` /
 * `visibilitychange→hidden` flush makes the loss window safe across
 * tab close, reload, and mobile background.
 */

'use client';

import { openDB, type IDBPDatabase } from 'idb';
import type { StateStorage } from 'zustand/middleware';

const DB_NAME = 'quant-app';
const DB_VERSION = 5;
const STORES = ['sectors', 'blacklist', 'settings', 'layout', 'ui'] as const;
type StoreName = (typeof STORES)[number];

const PERSIST_DEBOUNCE_MS = 75;

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDb(): Promise<IDBPDatabase> {
  if (dbPromise === null) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        for (const name of STORES) {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name);
          }
        }
      },
    });
  }
  return dbPromise;
}

function isIdbAvailable(): boolean {
  return typeof window !== 'undefined' && 'indexedDB' in window;
}

interface PendingWrite {
  readonly store: StoreName;
  readonly name: string;
  value: string;
  timer: ReturnType<typeof setTimeout> | null;
}

const pending = new Map<string, PendingWrite>();
let flushHookInstalled = false;

function pendingKey(store: StoreName, name: string): string {
  return `${store}/${name}`;
}

async function flushPending(p: PendingWrite): Promise<void> {
  pending.delete(pendingKey(p.store, p.name));
  if (p.timer !== null) {
    clearTimeout(p.timer);
    p.timer = null;
  }
  try {
    const db = await getDb();
    await db.put(p.store, p.value, p.name);
  } catch {
    // Persisting failed (quota / private mode) — UI still works.
  }
}

function flushAll(): void {
  for (const p of [...pending.values()]) void flushPending(p);
}

function installFlushHook(): void {
  if (flushHookInstalled) return;
  if (typeof window === 'undefined') return;
  flushHookInstalled = true;
  // `pagehide` is the reliable cross-browser tab-going-away signal —
  // unlike `beforeunload`, it fires on iOS Safari and on bfcache
  // freezes. `visibilitychange→hidden` covers the case of switching
  // away to another app on mobile (the page may never get pagehide).
  window.addEventListener('pagehide', flushAll);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAll();
  });
}

function scheduleWrite(store: StoreName, name: string, value: string): void {
  installFlushHook();
  const key = pendingKey(store, name);
  const existing = pending.get(key);
  if (existing !== undefined) {
    existing.value = value;
    if (existing.timer !== null) clearTimeout(existing.timer);
    existing.timer = setTimeout(() => {
      void flushPending(existing);
    }, PERSIST_DEBOUNCE_MS);
    return;
  }
  const fresh: PendingWrite = { store, name, value, timer: null };
  fresh.timer = setTimeout(() => {
    void flushPending(fresh);
  }, PERSIST_DEBOUNCE_MS);
  pending.set(key, fresh);
}

export function idbStorage(store: StoreName): StateStorage {
  if (!isIdbAvailable()) return localStorageFallback(store);

  return {
    async getItem(name: string): Promise<string | null> {
      try {
        const db = await getDb();
        // The store is keyed by `name` and `setItem` only ever writes
        // strings, so the read is a string (or undefined when absent).
        const value = (await db.get(store, name)) as string | undefined;
        return value ?? null;
      } catch {
        return null;
      }
    },
    setItem(name: string, value: string): void {
      // Synchronous from Zustand's PoV; the debounced flush owns the
      // actual IDB write so a rapid burst of setStates becomes one
      // transaction with the final value instead of N nested awaits.
      scheduleWrite(store, name, value);
    },
    async removeItem(name: string): Promise<void> {
      // Drop any pending debounced write for this key so we don't
      // race-resurrect deleted state.
      const key = pendingKey(store, name);
      const cur = pending.get(key);
      if (cur !== undefined) {
        if (cur.timer !== null) clearTimeout(cur.timer);
        pending.delete(key);
      }
      try {
        const db = await getDb();
        await db.delete(store, name);
      } catch {
        // ignore
      }
    },
  };
}

function localStorageFallback(store: StoreName): StateStorage {
  if (typeof window !== 'undefined' && 'localStorage' in window) {
    const prefix = `${DB_NAME}/${store}/`;
    return {
      getItem: (name) => window.localStorage.getItem(prefix + name),
      setItem: (name, value) => {
        try {
          window.localStorage.setItem(prefix + name, value);
        } catch {
          // quota exceeded; degrade silently — banner UI lands later
        }
      },
      removeItem: (name) => {
        window.localStorage.removeItem(prefix + name);
      },
    };
  }
  // Last-ditch fallback: in-memory map (SSR / unsupported envs).
  const map = new Map<string, string>();
  return {
    getItem: (name) => map.get(name) ?? null,
    setItem: (name, value) => {
      map.set(name, value);
    },
    removeItem: (name) => {
      map.delete(name);
    },
  };
}
