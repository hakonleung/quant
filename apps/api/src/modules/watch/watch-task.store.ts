/**
 * Per-user watch task store. Each user's tasks live at
 * `data/users/{userId}/watch/tasks.json`. Backed by
 * `UserScopedJsonStore`; the scheduler iterates all known users via
 * `UserStore.list()` and asks for each user's snapshot in turn.
 */

import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { WatchTaskSchema, watchTaskKey, type WatchMarket, type WatchTask } from '@quant/shared';

import { UserScopedJsonStore } from '../../common/user-scoped-store.js';
import { AUTH_CONFIG, type AuthConfigShape } from '../auth/config/auth.config.js';

const TasksFileSchema = z.array(WatchTaskSchema);

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

function migrateLegacyTasks(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.map((task) => {
    if (typeof task !== 'object' || task === null) return task;
    const t = { ...(task as Record<string, unknown>) };
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
  });
}

const FileSchema = z.preprocess(migrateLegacyTasks, TasksFileSchema);

@Injectable()
export class WatchTaskStore {
  private readonly logger = new Logger(WatchTaskStore.name);
  private readonly inner: UserScopedJsonStore<WatchTask[]>;

  constructor(@Inject(AUTH_CONFIG) cfg: AuthConfigShape) {
    this.inner = new UserScopedJsonStore<WatchTask[]>(cfg.dataRoot, {
      relativePath: (uid) => `users/${uid}/watch/tasks.json`,
      schema: FileSchema,
      fallback: () => [],
      logger: this.logger,
    });
  }

  async list(userId: string): Promise<readonly WatchTask[]> {
    const arr = await this.inner.snapshot(userId);
    return [...arr].sort((a, b) =>
      watchTaskKey(a.market, a.code).localeCompare(watchTaskKey(b.market, b.code)),
    );
  }

  async get(userId: string, market: WatchMarket, code: string): Promise<WatchTask | undefined> {
    const arr = await this.inner.snapshot(userId);
    const key = watchTaskKey(market, code);
    return arr.find((t) => watchTaskKey(t.market, t.code) === key);
  }

  async upsert(userId: string, task: WatchTask, allowReplace = false): Promise<void> {
    await this.inner.mutate(userId, (current) => {
      const key = watchTaskKey(task.market, task.code);
      const idx = current.findIndex((t) => watchTaskKey(t.market, t.code) === key);
      if (idx < 0) return [...current, task];
      if (!allowReplace) {
        throw new Error(`task ${key} already exists`);
      }
      const next = [...current];
      next[idx] = task;
      return next;
    });
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
      const idx = current.findIndex((t) => watchTaskKey(t.market, t.code) === key);
      if (idx < 0) return current;
      const cur = current[idx];
      if (cur === undefined) return current;
      next = updater(cur);
      const arr = [...current];
      arr[idx] = next;
      return arr;
    });
    return next;
  }

  async delete(userId: string, market: WatchMarket, code: string): Promise<boolean> {
    let removed = false;
    await this.inner.mutate(userId, (current) => {
      const key = watchTaskKey(market, code);
      const next = current.filter((t) => watchTaskKey(t.market, t.code) !== key);
      removed = next.length !== current.length;
      return next;
    });
    return removed;
  }

  async deleteByGroup(userId: string, groupName: string): Promise<number> {
    let count = 0;
    await this.inner.mutate(userId, (current) => {
      const next = current.filter((t) => t.groupName !== groupName);
      count = current.length - next.length;
      return next;
    });
    return count;
  }

  /**
   * Snapshot for the scheduler. Returns a frozen array so the scheduler
   * can iterate without holding a per-user lock; mutations route back
   * through `patch()`.
   */
  async snapshot(userId: string): Promise<readonly WatchTask[]> {
    const arr = await this.inner.snapshot(userId);
    return Object.freeze([...arr]);
  }

  async flushNow(userId: string): Promise<void> {
    await this.inner.flushNow(userId);
  }

  async flushAll(): Promise<void> {
    await this.inner.flushAll();
  }
}
