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
 */

'use client';

import { openDB, type IDBPDatabase } from 'idb';
import type { StateStorage } from 'zustand/middleware';

const DB_NAME = 'quant-app';
const DB_VERSION = 4;
const STORES = ['sectors', 'blacklist', 'settings', 'layout'] as const;
type StoreName = (typeof STORES)[number];

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
    async setItem(name: string, value: string): Promise<void> {
      try {
        const db = await getDb();
        await db.put(store, value, name);
      } catch {
        // Persisting failed (quota / private mode) — UI still works.
      }
    },
    async removeItem(name: string): Promise<void> {
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
