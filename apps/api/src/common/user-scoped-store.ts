/**
 * Per-user JSON store helper. Each user gets its own snapshot file under
 * `${dataRoot}/${relativePath(userId)}` with the same `tmp + rename`
 * atomicity guarantees and ≥ `minFlushIntervalMs` write throttling that
 * `LedgerStore` / `WatchTaskStore` rely on.
 *
 * Snapshots are cached per active userId. Idle users are evicted by an
 * LRU+TTL policy so a deployment with thousands of accounts doesn't keep
 * every user's data resident; an eviction always flushes the dirty bit
 * first so we never lose a pending write.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ZodTypeAny } from 'zod';

import { atomicWriteJson, readJsonOr } from '../modules/watch/domain/atomic-json.js';

const DEFAULT_MIN_FLUSH_INTERVAL_MS = 1_000;
const DEFAULT_MAX_ACTIVE_USERS = 100;
const DEFAULT_USER_TTL_MS = 30 * 60 * 1000;

export interface UserScopedJsonStoreOptions<T> {
  /** Resolves a user-relative path under `dataRoot`. */
  readonly relativePath: (userId: string) => string;
  /**
   * Validates the on-disk shape; failed parse → fallback. Typed as the
   * input-permissive `ZodTypeAny` so schemas built with `.default(...)` /
   * `.optional()` (input ≠ output) plug in without manual casts.
   */
  readonly schema: ZodTypeAny;
  /** Returned when the file is absent or invalid. */
  readonly fallback: () => T;
  /** Override the per-user write throttle. */
  readonly minFlushIntervalMs?: number;
  /** Override the active-user cache cap. */
  readonly maxActiveUsers?: number;
  /** Override the per-user idle TTL. */
  readonly userTtlMs?: number;
  /** Optional logger; defaults to a noop. */
  readonly logger?: { warn: (msg: string) => void; log?: (msg: string) => void };
}

interface UserSlot<T> {
  value: T;
  loaded: boolean;
  dirty: boolean;
  flushing: Promise<void> | null;
  lastFlushAt: number;
  lastTouchedAt: number;
  mutex: Promise<unknown>;
}

export class UserScopedJsonStore<T> {
  private readonly slots = new Map<string, UserSlot<T>>();
  private readonly minFlushIntervalMs: number;
  private readonly maxActiveUsers: number;
  private readonly userTtlMs: number;
  private readonly logger: { warn: (m: string) => void; log?: (m: string) => void };

  constructor(
    private readonly dataRoot: string,
    private readonly opts: UserScopedJsonStoreOptions<T>,
  ) {
    this.minFlushIntervalMs = opts.minFlushIntervalMs ?? DEFAULT_MIN_FLUSH_INTERVAL_MS;
    this.maxActiveUsers = opts.maxActiveUsers ?? DEFAULT_MAX_ACTIVE_USERS;
    this.userTtlMs = opts.userTtlMs ?? DEFAULT_USER_TTL_MS;
    this.logger = opts.logger ?? { warn: () => undefined };
  }

  filePath(userId: string): string {
    return path.join(this.dataRoot, this.opts.relativePath(userId));
  }

  async snapshot(userId: string): Promise<T> {
    const slot = await this.ensureLoaded(userId);
    return slot.value;
  }

  async replace(userId: string, value: T): Promise<T> {
    const slot = await this.ensureLoaded(userId);
    return this.runLocked(slot, async () => {
      slot.value = value;
      slot.dirty = true;
      await this.flushIfDue(userId, slot);
      return slot.value;
    });
  }

  async mutate(userId: string, fn: (current: T) => T | Promise<T>): Promise<T> {
    const slot = await this.ensureLoaded(userId);
    return this.runLocked(slot, async () => {
      const next = await fn(slot.value);
      slot.value = next;
      slot.dirty = true;
      await this.flushIfDue(userId, slot);
      return slot.value;
    });
  }

  async flushNow(userId: string): Promise<void> {
    const slot = this.slots.get(userId);
    if (slot === undefined) return;
    await this.runLocked(slot, async () => {
      slot.lastFlushAt = 0;
      await this.flushIfDue(userId, slot, true);
    });
  }

  async flushAll(): Promise<void> {
    for (const userId of Array.from(this.slots.keys())) {
      await this.flushNow(userId);
    }
  }

  /** For tests / lifecycle: drop a user's cached snapshot (after flushing). */
  async evict(userId: string): Promise<void> {
    await this.flushNow(userId);
    this.slots.delete(userId);
  }

  private async ensureLoaded(userId: string): Promise<UserSlot<T>> {
    let slot = this.slots.get(userId);
    if (slot !== undefined) {
      slot.lastTouchedAt = Date.now();
      this.evictIdleAndOverflow(userId);
      return slot;
    }
    slot = {
      value: this.opts.fallback(),
      loaded: false,
      dirty: false,
      flushing: null,
      lastFlushAt: 0,
      lastTouchedAt: Date.now(),
      mutex: Promise.resolve(),
    };
    this.slots.set(userId, slot);
    await this.runLocked(slot, async () => {
      if ((slot as UserSlot<T>).loaded) return;
      const file = this.filePath(userId);
      const raw = await readJsonOr<unknown>(file, null);
      if (raw === null) {
        (slot as UserSlot<T>).value = this.opts.fallback();
      } else {
        const parsed = this.opts.schema.safeParse(raw);
        if (!parsed.success) {
          this.logger.warn(
            `user-scoped store ${file} failed validation, using fallback: ${parsed.error.message}`,
          );
          (slot as UserSlot<T>).value = this.opts.fallback();
        } else {
          (slot as UserSlot<T>).value = parsed.data as T;
        }
      }
      (slot as UserSlot<T>).loaded = true;
    });
    this.evictIdleAndOverflow(userId);
    return slot;
  }

  private async runLocked<R>(slot: UserSlot<T>, fn: () => Promise<R>): Promise<R> {
    const next = slot.mutex.then(fn, fn);
    slot.mutex = next.catch(() => undefined);
    return next;
  }

  private async flushIfDue(userId: string, slot: UserSlot<T>, force = false): Promise<void> {
    if (!slot.dirty) return;
    const now = Date.now();
    const due = force || now - slot.lastFlushAt >= this.minFlushIntervalMs;
    if (!due) return;
    if (slot.flushing !== null) return;
    slot.flushing = this.runFlush(userId, slot);
    try {
      await slot.flushing;
    } finally {
      slot.flushing = null;
    }
  }

  private async runFlush(userId: string, slot: UserSlot<T>): Promise<void> {
    slot.dirty = false;
    slot.lastFlushAt = Date.now();
    try {
      const target = this.filePath(userId);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await atomicWriteJson(target, slot.value);
    } catch (err) {
      slot.dirty = true;
      throw err;
    }
  }

  private evictIdleAndOverflow(keepUserId: string): void {
    const now = Date.now();
    for (const [id, slot] of this.slots) {
      if (id === keepUserId) continue;
      if (slot.dirty || slot.flushing !== null) continue;
      if (now - slot.lastTouchedAt >= this.userTtlMs) {
        this.slots.delete(id);
      }
    }
    if (this.slots.size <= this.maxActiveUsers) return;
    const candidates = Array.from(this.slots.entries())
      .filter(([id, s]) => id !== keepUserId && !s.dirty && s.flushing === null)
      .sort((a, b) => a[1].lastTouchedAt - b[1].lastTouchedAt);
    while (this.slots.size > this.maxActiveUsers && candidates.length > 0) {
      const next = candidates.shift();
      if (next === undefined) break;
      this.slots.delete(next[0]);
    }
  }
}
