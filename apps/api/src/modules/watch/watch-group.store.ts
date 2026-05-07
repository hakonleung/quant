/**
 * In-memory + file-backed Watch group store.
 *
 * Mirrors `WatchTaskStore`: single mutex, atomic `tmp+rename` flush
 * to `data/watch/groups.json`, throttled to ≤ 1 write/s with a dirty
 * bit so a flush in flight will pick up subsequent mutations.
 *
 * Groups own `conditions / intervalSec / pushIntervalSec`; tasks
 * reference groups by `groupName` (FK).
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { WatchGroupSchema, type WatchGroup } from '@quant/shared';
import { atomicWriteJson, readJsonOr } from './domain/atomic-json.js';
import { WATCH_DATA_DIR } from './watch-task.store.js';

const GroupsFileSchema = z.array(WatchGroupSchema);

const MIN_FLUSH_INTERVAL_MS = 1_000;

@Injectable()
export class WatchGroupStore {
  private readonly logger = new Logger(WatchGroupStore.name);
  private readonly groups = new Map<string, WatchGroup>();
  private dirty = false;
  private flushing: Promise<void> | null = null;
  private lastFlushAt = 0;
  private mutexChain: Promise<unknown> = Promise.resolve();
  private loaded = false;

  constructor(@Inject(WATCH_DATA_DIR) private readonly dataDir: string) {}

  private get groupsFile(): string {
    return `${this.dataDir}/groups.json`;
  }

  async load(): Promise<void> {
    return this.withLock(async () => {
      if (this.loaded) return;
      const raw = await readJsonOr<unknown>(this.groupsFile, []);
      const parsed = GroupsFileSchema.safeParse(raw);
      if (!parsed.success) {
        this.logger.warn(`groups.json failed validation, starting empty: ${parsed.error.message}`);
        this.loaded = true;
        return;
      }
      for (const g of parsed.data) {
        this.groups.set(g.name, g);
      }
      this.loaded = true;
      this.logger.log(`loaded ${String(this.groups.size)} watch groups`);
    });
  }

  list(): readonly WatchGroup[] {
    return Array.from(this.groups.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): WatchGroup | undefined {
    return this.groups.get(name);
  }

  has(name: string): boolean {
    return this.groups.has(name);
  }

  async upsert(group: WatchGroup, allowReplace = false): Promise<void> {
    return this.withLock(async () => {
      if (!allowReplace && this.groups.has(group.name)) {
        throw new Error(`group ${group.name} already exists`);
      }
      this.groups.set(group.name, group);
      this.markDirty();
      await this.flushIfDue();
    });
  }

  async delete(name: string): Promise<boolean> {
    let removed = false;
    await this.withLock(async () => {
      removed = this.groups.delete(name);
      if (removed) {
        this.markDirty();
        await this.flushIfDue();
      }
    });
    return removed;
  }

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
    if (!force && now - this.lastFlushAt < MIN_FLUSH_INTERVAL_MS) return;
    if (this.flushing !== null) {
      await this.flushing;
      return;
    }
    const data = Array.from(this.groups.values());
    this.dirty = false;
    this.flushing = atomicWriteJson(this.groupsFile, data)
      .then(() => {
        this.lastFlushAt = Date.now();
      })
      .catch((err: unknown) => {
        this.dirty = true;
        this.logger.error(`groups.json flush failed: ${String(err)}`);
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
