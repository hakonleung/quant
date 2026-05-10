/**
 * Per-user watch task store. Each user's tasks live at
 * `data/users/{userId}/watch/tasks.json`.
 *
 * File format v2: `{ version: 2, nextIdx: number, tasks: WatchTask[] }`.
 * Migration from v1 (bare array): assigns sequential idx 1..N to existing
 * tasks on first read, sets nextIdx = N+1.
 */

import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { WatchTaskSchema, watchTaskKey, type WatchMarket, type WatchTask } from '@quant/shared';

import { UserScopedJsonStore } from '../../common/user-scoped-store.js';
import { AUTH_CONFIG, type AuthConfigShape } from '../auth/config/auth.config.js';

const TasksFileV2Schema = z.object({
  version: z.literal(2),
  nextIdx: z.number().int().min(1),
  tasks: z.array(WatchTaskSchema),
});
type TasksFileV2 = z.infer<typeof TasksFileV2Schema>;

const LEGACY_TASK_KEYS_TO_DROP = ['lastMatchAt', 'lastSamplePrice'] as const;

/**
 * Stable name for legacy tasks: `legacy-<sha1(conds JSON)[0..6]>`.
 * Identical conds → identical group name → tasks join the same group.
 */
export function synthesizeGroupName(conditions: unknown): string {
  const sig = JSON.stringify(conditions ?? []);
  const hash = createHash('sha1').update(sig).digest('hex').slice(0, 6);
  return `legacy-${hash}`;
}

function migrateLegacyTask(task: Record<string, unknown>): Record<string, unknown> {
  const t = { ...task };
  const conds = t['conditions'];
  if (Array.isArray(conds)) {
    t['conditions'] = conds.map((c) => {
      if (typeof c !== 'object' || c === null) return c;
      const cc = { ...(c as Record<string, unknown>) };
      if (cc['kind'] === 'pct') {
        if (cc['op'] === undefined) {
          const thr = cc['thresholdPct'];
          cc['op'] = typeof thr === 'string' && thr.trim().startsWith('-') ? 'lte' : 'gte';
        }
        if (cc['baseline'] === 'prev') {
          cc['baseline'] = 'prev_close';
        }
      }
      return cc;
    });
  }
  for (const k of LEGACY_TASK_KEYS_TO_DROP) {
    delete t[k];
  }
  if (t['lastHitPrice'] === undefined) {
    t['lastHitPrice'] = null;
  }
  if (typeof t['groupName'] !== 'string' || t['groupName'].length === 0) {
    t['groupName'] = synthesizeGroupName(t['conditions']);
  }
  return t;
}

function migrateToV2(raw: unknown): unknown {
  // Already v2 — pass through
  if (
    typeof raw === 'object' &&
    raw !== null &&
    !Array.isArray(raw) &&
    (raw as Record<string, unknown>)['version'] === 2
  ) {
    return raw;
  }
  // v1 bare array (or unknown) → promote to v2
  const arr = Array.isArray(raw) ? raw : [];
  let nextIdx = 1;
  const tasks = arr.map((task, i) => {
    if (typeof task !== 'object' || task === null) return task;
    const t = migrateLegacyTask(task as Record<string, unknown>);
    // Assign idx if missing
    if (typeof t['idx'] !== 'number') {
      t['idx'] = i + 1;
      nextIdx = i + 2;
    } else {
      nextIdx = Math.max(nextIdx, (t['idx'] as number) + 1);
    }
    return t;
  });
  return { version: 2, nextIdx, tasks };
}

const FileSchema = z.preprocess(migrateToV2, TasksFileV2Schema);

@Injectable()
export class WatchTaskStore {
  private readonly logger = new Logger(WatchTaskStore.name);
  private readonly inner: UserScopedJsonStore<TasksFileV2>;

  constructor(@Inject(AUTH_CONFIG) cfg: AuthConfigShape) {
    this.inner = new UserScopedJsonStore<TasksFileV2>(cfg.dataRoot, {
      relativePath: (uid) => `users/${uid}/watch/tasks.json`,
      schema: FileSchema,
      fallback: () => ({ version: 2, nextIdx: 1, tasks: [] }),
      logger: this.logger,
    });
  }

  async list(userId: string): Promise<readonly WatchTask[]> {
    const file = await this.inner.snapshot(userId);
    return [...file.tasks].sort((a, b) => a.idx - b.idx);
  }

  async get(userId: string, market: WatchMarket, code: string): Promise<WatchTask | undefined> {
    const file = await this.inner.snapshot(userId);
    const key = watchTaskKey(market, code);
    return file.tasks.find((t) => watchTaskKey(t.market, t.code) === key);
  }

  async getByIdx(userId: string, idx: number): Promise<WatchTask | undefined> {
    const file = await this.inner.snapshot(userId);
    return file.tasks.find((t) => t.idx === idx);
  }

  async upsert(
    userId: string,
    task: Omit<WatchTask, 'idx'> & { idx?: number },
    allowReplace = false,
  ): Promise<WatchTask> {
    let inserted: WatchTask | undefined;
    await this.inner.mutate(userId, (current) => {
      const key = watchTaskKey(task.market, task.code);
      const idx = current.tasks.findIndex((t) => watchTaskKey(t.market, t.code) === key);
      if (idx >= 0) {
        if (!allowReplace) {
          throw new Error(`task ${key} already exists`);
        }
        const existing = current.tasks[idx];
        if (existing === undefined) throw new Error(`task ${key} not found`);
        inserted = { ...existing, ...task, idx: existing.idx } as WatchTask;
        const next = [...current.tasks];
        next[idx] = inserted;
        return { ...current, tasks: next };
      }
      const newIdx = task.idx ?? current.nextIdx;
      inserted = { ...task, idx: newIdx } as WatchTask;
      return {
        ...current,
        nextIdx: Math.max(current.nextIdx, newIdx + 1),
        tasks: [...current.tasks, inserted],
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
    await this.inner.mutate(userId, (current) => {
      const key = watchTaskKey(market, code);
      const idx = current.tasks.findIndex((t) => watchTaskKey(t.market, t.code) === key);
      if (idx < 0) return current;
      const cur = current.tasks[idx];
      if (cur === undefined) return current;
      next = updater(cur);
      const arr = [...current.tasks];
      arr[idx] = next;
      return { ...current, tasks: arr };
    });
    return next;
  }

  async delete(userId: string, market: WatchMarket, code: string): Promise<boolean> {
    let removed = false;
    await this.inner.mutate(userId, (current) => {
      const key = watchTaskKey(market, code);
      const next = current.tasks.filter((t) => watchTaskKey(t.market, t.code) !== key);
      removed = next.length !== current.tasks.length;
      return { ...current, tasks: next };
    });
    return removed;
  }

  async deleteByIdx(userId: string, idx: number): Promise<WatchTask | undefined> {
    let removed: WatchTask | undefined;
    await this.inner.mutate(userId, (current) => {
      const found = current.tasks.find((t) => t.idx === idx);
      if (found === undefined) return current;
      removed = found;
      return { ...current, tasks: current.tasks.filter((t) => t.idx !== idx) };
    });
    return removed;
  }

  async deleteByGroup(userId: string, groupName: string): Promise<number> {
    let count = 0;
    await this.inner.mutate(userId, (current) => {
      const next = current.tasks.filter((t) => t.groupName !== groupName);
      count = current.tasks.length - next.length;
      return { ...current, tasks: next };
    });
    return count;
  }

  /**
   * Snapshot for the scheduler. Returns a frozen array so the scheduler
   * can iterate without holding a per-user lock; mutations route back
   * through `patch()`.
   */
  async snapshot(userId: string): Promise<readonly WatchTask[]> {
    const file = await this.inner.snapshot(userId);
    return Object.freeze([...file.tasks]);
  }

  async flushNow(userId: string): Promise<void> {
    await this.inner.flushNow(userId);
  }

  async flushAll(): Promise<void> {
    await this.inner.flushAll();
  }
}
