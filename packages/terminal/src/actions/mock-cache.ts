/**
 * In-memory + localStorage-backed mock cache for the terminal mock runner.
 *
 * Caching is intentionally simple: a hash of the cache-key array yields a
 * single string slot, with a TTL of `DEFAULT_TTL_MS`. Persistence is best-
 * effort — when localStorage is unavailable (SSR, quota), we fall back to
 * the in-memory map only.
 */

export const DEFAULT_TTL_MS = 60 * 60 * 1000; // 60 min

const STORAGE_PREFIX = 'tm.cache.';

interface Entry {
  readonly data: unknown;
  readonly ts: number;
}

export interface CacheStats {
  readonly entries: number;
  readonly hits: number;
  readonly misses: number;
}

export class MockCache {
  private readonly mem = new Map<string, Entry>();
  private hits = 0;
  private misses = 0;
  private readonly storage: Storage | null;
  private readonly ttlMs: number;

  constructor(storage: Storage | null = safeStorage(), ttlMs: number = DEFAULT_TTL_MS) {
    this.storage = storage;
    this.ttlMs = ttlMs;
    if (storage !== null) {
      // Pre-warm in-memory map from storage (cheap; entries are small).
      for (let i = 0; i < storage.length; i += 1) {
        const k = storage.key(i);
        if (k === null || !k.startsWith(STORAGE_PREFIX)) continue;
        const raw = storage.getItem(k);
        if (raw === null) continue;
        try {
          const e = JSON.parse(raw) as Entry;
          this.mem.set(k.slice(STORAGE_PREFIX.length), e);
        } catch {
          /* ignore corrupt entries */
        }
      }
    }
  }

  get(key: readonly (string | number | boolean)[]): unknown | undefined {
    const k = hashKey(key);
    const e = this.mem.get(k);
    if (e === undefined) {
      this.misses += 1;
      return undefined;
    }
    if (Date.now() - e.ts > this.ttlMs) {
      this.mem.delete(k);
      this.persistDelete(k);
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    return e.data;
  }

  set(key: readonly (string | number | boolean)[], data: unknown): void {
    const k = hashKey(key);
    const entry: Entry = { data, ts: Date.now() };
    this.mem.set(k, entry);
    this.persistSet(k, entry);
  }

  invalidate(prefix: readonly (string | number | boolean)[]): number {
    const p = hashKey(prefix);
    let n = 0;
    for (const k of [...this.mem.keys()]) {
      if (k === p || k.startsWith(`${p}|`)) {
        this.mem.delete(k);
        this.persistDelete(k);
        n += 1;
      }
    }
    return n;
  }

  clear(): void {
    for (const k of [...this.mem.keys()]) {
      this.persistDelete(k);
    }
    this.mem.clear();
  }

  stats(): CacheStats {
    return { entries: this.mem.size, hits: this.hits, misses: this.misses };
  }

  private persistSet(key: string, entry: Entry): void {
    if (this.storage === null) return;
    try {
      this.storage.setItem(`${STORAGE_PREFIX}${key}`, JSON.stringify(entry));
    } catch {
      /* quota / disabled — drop persistence silently */
    }
  }

  private persistDelete(key: string): void {
    if (this.storage === null) return;
    try {
      this.storage.removeItem(`${STORAGE_PREFIX}${key}`);
    } catch {
      /* ignore */
    }
  }
}

export function hashKey(parts: readonly (string | number | boolean)[]): string {
  return parts.map((p) => String(p)).join('|');
}

function safeStorage(): Storage | null {
  try {
    if (typeof globalThis !== 'undefined' && 'localStorage' in globalThis) {
      const s = (globalThis as { localStorage?: Storage }).localStorage;
      return s ?? null;
    }
  } catch {
    /* ignore — sandboxed contexts throw on .localStorage access */
  }
  return null;
}
