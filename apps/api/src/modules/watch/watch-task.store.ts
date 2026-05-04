/**
 * In-memory + file-backed Watch task store
 * (`docs/modules/W-0-watch.md` §3.2 / §8).
 *
 * Single mutex serialises both CRUD and scheduler-side mutations. Writes
 * to `data/watch/tasks.json` are atomic (`tmp + rename`) and throttled to
 * at most one flush per second; if a flush is already in flight we mark
 * the store dirty and the flush re-runs once the current one finishes.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { WatchTaskSchema, watchTaskKey, type WatchMarket, type WatchTask } from '@quant/shared';
import { atomicWriteJson, readJsonOr } from './domain/atomic-json.js';

export const WATCH_DATA_DIR = Symbol('WATCH_DATA_DIR');

const TasksFileSchema = z.array(WatchTaskSchema);

const MIN_FLUSH_INTERVAL_MS = 1_000;

@Injectable()
export class WatchTaskStore {
  private readonly logger = new Logger(WatchTaskStore.name);
  private readonly tasks = new Map<string, WatchTask>();
  private dirty = false;
  private flushing: Promise<void> | null = null;
  private lastFlushAt = 0;
  private mutexChain: Promise<unknown> = Promise.resolve();
  private loaded = false;

  constructor(@Inject(WATCH_DATA_DIR) private readonly dataDir: string) {}

  private get tasksFile(): string {
    return `${this.dataDir}/tasks.json`;
  }

  async load(): Promise<void> {
    return this.withLock(async () => {
      if (this.loaded) return;
      const raw = await readJsonOr<unknown>(this.tasksFile, []);
      const parsed = TasksFileSchema.safeParse(raw);
      if (!parsed.success) {
        this.logger.warn(`tasks.json failed validation, starting empty: ${parsed.error.message}`);
        this.loaded = true;
        return;
      }
      for (const t of parsed.data) {
        this.tasks.set(watchTaskKey(t.market, t.code), t);
      }
      this.loaded = true;
      this.logger.log(`loaded ${String(this.tasks.size)} watch tasks`);
    });
  }

  list(): readonly WatchTask[] {
    return Array.from(this.tasks.values()).sort((a, b) =>
      watchTaskKey(a.market, a.code).localeCompare(watchTaskKey(b.market, b.code)),
    );
  }

  get(market: WatchMarket, code: string): WatchTask | undefined {
    return this.tasks.get(watchTaskKey(market, code));
  }

  async upsert(task: WatchTask, allowReplace = false): Promise<void> {
    return this.withLock(async () => {
      const key = watchTaskKey(task.market, task.code);
      if (!allowReplace && this.tasks.has(key)) {
        throw new Error(`task ${key} already exists`);
      }
      this.tasks.set(key, task);
      this.markDirty();
      await this.flushIfDue();
    });
  }

  async patch(
    market: WatchMarket,
    code: string,
    updater: (current: WatchTask) => WatchTask,
  ): Promise<WatchTask | undefined> {
    let next: WatchTask | undefined;
    await this.withLock(async () => {
      const key = watchTaskKey(market, code);
      const current = this.tasks.get(key);
      if (current === undefined) return;
      next = updater(current);
      this.tasks.set(key, next);
      this.markDirty();
      await this.flushIfDue();
    });
    return next;
  }

  async delete(market: WatchMarket, code: string): Promise<boolean> {
    let removed = false;
    await this.withLock(async () => {
      removed = this.tasks.delete(watchTaskKey(market, code));
      if (removed) {
        this.markDirty();
        await this.flushIfDue();
      }
    });
    return removed;
  }

  /**
   * Snapshot for the scheduler. Returns a frozen array so the scheduler
   * can iterate without holding the lock; mutations in the inner loop
   * route through `patch()` which reacquires the lock.
   */
  snapshot(): readonly WatchTask[] {
    return Object.freeze([...this.tasks.values()]);
  }

  /** Force a flush — used at shutdown. */
  async flushNow(): Promise<void> {
    await this.withLock(async () => {
      this.lastFlushAt = 0;
      await this.flushIfDue(true);
    });
  }

  private markDirty(): void {
    this.dirty = true;
  }

  private async flushIfDue(force = false): Promise<void> {
    if (!this.dirty) return;
    const now = Date.now();
    if (!force && now - this.lastFlushAt < MIN_FLUSH_INTERVAL_MS) {
      // Defer — the next flushIfDue call will pick this up.
      return;
    }
    if (this.flushing !== null) {
      await this.flushing;
      return;
    }
    const data = Array.from(this.tasks.values());
    this.dirty = false;
    this.flushing = atomicWriteJson(this.tasksFile, data)
      .then(() => {
        this.lastFlushAt = Date.now();
      })
      .catch((err: unknown) => {
        // Rollback dirty so a later mutation triggers another attempt.
        this.dirty = true;
        this.logger.error(`tasks.json flush failed: ${String(err)}`);
      })
      .finally(() => {
        this.flushing = null;
      });
    await this.flushing;
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutexChain.then(fn, fn);
    this.mutexChain = next.catch(() => undefined);
    return next;
  }
}
