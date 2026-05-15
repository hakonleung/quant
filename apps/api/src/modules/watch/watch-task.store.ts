/**
 * Per-user watch-task facade. Reads/writes the `watch.tasks` slice of
 * the consolidated `data/users/{uid}/user.parquet` via `UserBlobStore`.
 *
 * Tasks live as `{ version: 2, nextIdx, tasks[] }` because the
 * monotonic `nextIdx` counter must outlive deletes — the same shape
 * the prior parquet store used. Consumers (`WatchService`,
 * `WatchScheduler`, watch instructions) keep using the same public
 * methods; they don't see the layout change.
 */

import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { watchTaskKey, type WatchMarket, type WatchTask } from '@quant/shared';

import { UserBlobStore } from '../../common/storage/user-blob.store.js';

export function synthesizeGroupName(conditions: unknown): string {
  const sig = JSON.stringify(conditions ?? []);
  const hash = createHash('sha1').update(sig).digest('hex').slice(0, 6);
  return `legacy-${hash}`;
}

@Injectable()
export class WatchTaskStore {
  constructor(@Inject(UserBlobStore) private readonly blob: UserBlobStore) {}

  async list(userId: string): Promise<readonly WatchTask[]> {
    const file = (await this.blob.read(userId)).watch.tasks;
    return [...file.tasks].sort((a, b) => a.idx - b.idx);
  }

  async get(userId: string, market: WatchMarket, code: string): Promise<WatchTask | undefined> {
    const file = (await this.blob.read(userId)).watch.tasks;
    const key = watchTaskKey(market, code);
    return file.tasks.find((t) => watchTaskKey(t.market, t.code) === key);
  }

  async getByIdx(userId: string, idx: number): Promise<WatchTask | undefined> {
    const file = (await this.blob.read(userId)).watch.tasks;
    return file.tasks.find((t) => t.idx === idx);
  }

  async upsert(
    userId: string,
    task: Omit<WatchTask, 'idx'> & { idx?: number },
    allowReplace = false,
  ): Promise<WatchTask> {
    let inserted: WatchTask | undefined;
    await this.blob.update(userId, (b) => {
      const file = b.watch.tasks;
      const key = watchTaskKey(task.market, task.code);
      const i = file.tasks.findIndex((t) => watchTaskKey(t.market, t.code) === key);
      if (i >= 0) {
        if (!allowReplace) {
          throw new Error(`task ${key} already exists`);
        }
        const existing = file.tasks[i];
        if (existing === undefined) throw new Error(`task ${key} not found`);
        inserted = { ...existing, ...task, idx: existing.idx } as WatchTask;
        const next = [...file.tasks];
        next[i] = inserted;
        return { ...b, watch: { ...b.watch, tasks: { ...file, tasks: next } } };
      }
      const newIdx = task.idx ?? file.nextIdx;
      inserted = { ...task, idx: newIdx } as WatchTask;
      return {
        ...b,
        watch: {
          ...b.watch,
          tasks: {
            ...file,
            nextIdx: Math.max(file.nextIdx, newIdx + 1),
            tasks: [...file.tasks, inserted],
          },
        },
      };
    });
    if (inserted === undefined) throw new Error('upsert failed');
    return inserted;
  }

  async patch(
    userId: string,
    market: WatchMarket,
    code: string,
    updater: (current: WatchTask) => WatchTask,
  ): Promise<WatchTask | undefined> {
    let next: WatchTask | undefined;
    await this.blob.update(userId, (b) => {
      const file = b.watch.tasks;
      const key = watchTaskKey(market, code);
      const i = file.tasks.findIndex((t) => watchTaskKey(t.market, t.code) === key);
      if (i < 0) return b;
      const cur = file.tasks[i];
      if (cur === undefined) return b;
      next = updater(cur);
      const arr = [...file.tasks];
      arr[i] = next;
      return { ...b, watch: { ...b.watch, tasks: { ...file, tasks: arr } } };
    });
    return next;
  }

  async delete(userId: string, market: WatchMarket, code: string): Promise<boolean> {
    let removed = false;
    await this.blob.update(userId, (b) => {
      const file = b.watch.tasks;
      const key = watchTaskKey(market, code);
      const next = file.tasks.filter((t) => watchTaskKey(t.market, t.code) !== key);
      removed = next.length !== file.tasks.length;
      if (!removed) return b;
      return { ...b, watch: { ...b.watch, tasks: { ...file, tasks: next } } };
    });
    return removed;
  }

  async deleteByIdx(userId: string, idx: number): Promise<WatchTask | undefined> {
    let removed: WatchTask | undefined;
    await this.blob.update(userId, (b) => {
      const file = b.watch.tasks;
      const found = file.tasks.find((t) => t.idx === idx);
      if (found === undefined) return b;
      removed = found;
      return {
        ...b,
        watch: {
          ...b.watch,
          tasks: { ...file, tasks: file.tasks.filter((t) => t.idx !== idx) },
        },
      };
    });
    return removed;
  }

  async deleteByGroup(userId: string, groupName: string): Promise<number> {
    let count = 0;
    await this.blob.update(userId, (b) => {
      const file = b.watch.tasks;
      const next = file.tasks.filter((t) => t.groupName !== groupName);
      count = file.tasks.length - next.length;
      if (count === 0) return b;
      return { ...b, watch: { ...b.watch, tasks: { ...file, tasks: next } } };
    });
    return count;
  }

  async snapshot(userId: string): Promise<readonly WatchTask[]> {
    const file = (await this.blob.read(userId)).watch.tasks;
    return Object.freeze([...file.tasks]);
  }

  async flushNow(userId: string): Promise<void> {
    await this.blob.flush(userId);
  }

  async flushAll(): Promise<void> {
    await this.blob.flush();
  }
}
