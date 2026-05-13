/**
 * Per-user watch task store. Backed by `UserScopedRecordStore<WatchTaskRow>`
 * — one singleton row per user with the full `{ version, nextIdx, tasks }`
 * snapshot JSON-encoded.
 *
 * Why a singleton blob? `WatchTask` has nested conditions (each a small
 * AST), the `nextIdx` counter is monotonic across deletes, and several
 * operations (`patch`, `upsert`) need read-modify-write atomicity on
 * the whole snapshot. Singleton-blob mirrors the legacy `tasks.json`
 * format exactly — zero behavioral risk. Same shortcut as
 * `WatchGroupStore`.
 *
 * Self-migration: legacy `data/users/{userId}/watch/tasks.json` is
 * adopted on first access, then renamed `.bak`. The v1 → v2 conversion
 * (idx allocation, groupName synthesis, dropped fields) is preserved.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { WatchTaskSchema, watchTaskKey, type WatchMarket, type WatchTask } from '@quant/shared';

import { FileSystemUserScopedRecordStore } from '../../common/storage/adapters/filesystem-user-scoped-record.store.js';
import type {
  RecordTableSpec,
} from '../../common/storage/ports/record-store.port.js';
import type { UserScopedRecordStore } from '../../common/storage/ports/user-scoped-record-store.port.js';
import { AUTH_CONFIG, type AuthConfigShape } from '../auth/config/auth.config.js';
import { WATCH_TASK_USER_RECORD_STORE } from './watch.tokens.js';

const SINGLETON_KEY = 'singleton' as const;

const TasksFileV2Schema = z.object({
  version: z.literal(2),
  nextIdx: z.number().int().min(1),
  tasks: z.array(WatchTaskSchema),
});
type TasksFileV2 = z.infer<typeof TasksFileV2Schema>;

const EMPTY_FILE: TasksFileV2 = { version: 2, nextIdx: 1, tasks: [] };

const LEGACY_TASK_KEYS_TO_DROP = ['lastMatchAt', 'lastSamplePrice'] as const;

export interface WatchTaskRow {
  readonly id: typeof SINGLETON_KEY;
  readonly payload_json: string;
}

export const WatchTaskRowSchema = z.object({
  id: z.literal(SINGLETON_KEY),
  payload_json: z.string(),
});

export const WATCH_TASK_TABLE_SPEC: RecordTableSpec<WatchTaskRow> = {
  table: 'watch_tasks',
  schema: WatchTaskRowSchema,
  pk: (row) => row.id,
  columns: [
    { name: 'id', type: 'VARCHAR', nullable: false, primaryKey: true },
    { name: 'payload_json', type: 'VARCHAR', nullable: false },
  ],
};

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

function migrateToV2(raw: unknown): TasksFileV2 {
  if (
    typeof raw === 'object' &&
    raw !== null &&
    !Array.isArray(raw) &&
    (raw as Record<string, unknown>)['version'] === 2
  ) {
    const parsed = TasksFileV2Schema.safeParse(raw);
    if (parsed.success) return parsed.data;
    return EMPTY_FILE;
  }
  const arr = Array.isArray(raw) ? raw : [];
  let nextIdx = 1;
  const tasks = arr.map((task, i) => {
    if (typeof task !== 'object' || task === null) return task;
    const t = migrateLegacyTask(task as Record<string, unknown>);
    if (typeof t['idx'] !== 'number') {
      t['idx'] = i + 1;
      nextIdx = i + 2;
    } else {
      nextIdx = Math.max(nextIdx, (t['idx'] as number) + 1);
    }
    return t;
  });
  const candidate = { version: 2 as const, nextIdx, tasks };
  const parsed = TasksFileV2Schema.safeParse(candidate);
  return parsed.success ? parsed.data : EMPTY_FILE;
}

function decodeLegacy(raw: unknown): readonly WatchTaskRow[] {
  const migrated = migrateToV2(raw);
  return [{ id: SINGLETON_KEY, payload_json: JSON.stringify(migrated) }];
}

export function buildWatchTaskUserScopedStore(
  cfg: AuthConfigShape,
  logger: { warn: (m: string) => void; log?: (m: string) => void },
): UserScopedRecordStore<WatchTaskRow> {
  return new FileSystemUserScopedRecordStore<WatchTaskRow>({
    dataRoot: cfg.dataRoot,
    spec: WATCH_TASK_TABLE_SPEC,
    legacyJsonPath: (uid) => path.join(cfg.dataRoot, 'users', uid, 'watch', 'tasks.json'),
    legacyDecode: decodeLegacy,
    logger,
  });
}

@Injectable()
export class WatchTaskStore {
  private readonly logger = new Logger(WatchTaskStore.name);
  private readonly mutexByUser = new Map<string, Promise<unknown>>();

  constructor(
    @Inject(WATCH_TASK_USER_RECORD_STORE)
    private readonly inner: UserScopedRecordStore<WatchTaskRow>,
    @Inject(AUTH_CONFIG) cfg: AuthConfigShape,
  ) {
    void cfg;
    void this.logger;
  }

  async list(userId: string): Promise<readonly WatchTask[]> {
    const file = await this.loadFile(userId);
    return [...file.tasks].sort((a, b) => a.idx - b.idx);
  }

  async get(userId: string, market: WatchMarket, code: string): Promise<WatchTask | undefined> {
    const file = await this.loadFile(userId);
    const key = watchTaskKey(market, code);
    return file.tasks.find((t) => watchTaskKey(t.market, t.code) === key);
  }

  async getByIdx(userId: string, idx: number): Promise<WatchTask | undefined> {
    const file = await this.loadFile(userId);
    return file.tasks.find((t) => t.idx === idx);
  }

  async upsert(
    userId: string,
    task: Omit<WatchTask, 'idx'> & { idx?: number },
    allowReplace = false,
  ): Promise<WatchTask> {
    let inserted: WatchTask | undefined;
    await this.mutateFile(userId, (current) => {
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
    await this.mutateFile(userId, (current) => {
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
    await this.mutateFile(userId, (current) => {
      const key = watchTaskKey(market, code);
      const next = current.tasks.filter((t) => watchTaskKey(t.market, t.code) !== key);
      removed = next.length !== current.tasks.length;
      return { ...current, tasks: next };
    });
    return removed;
  }

  async deleteByIdx(userId: string, idx: number): Promise<WatchTask | undefined> {
    let removed: WatchTask | undefined;
    await this.mutateFile(userId, (current) => {
      const found = current.tasks.find((t) => t.idx === idx);
      if (found === undefined) return current;
      removed = found;
      return { ...current, tasks: current.tasks.filter((t) => t.idx !== idx) };
    });
    return removed;
  }

  async deleteByGroup(userId: string, groupName: string): Promise<number> {
    let count = 0;
    await this.mutateFile(userId, (current) => {
      const next = current.tasks.filter((t) => t.groupName !== groupName);
      count = current.tasks.length - next.length;
      return { ...current, tasks: next };
    });
    return count;
  }

  async snapshot(userId: string): Promise<readonly WatchTask[]> {
    const file = await this.loadFile(userId);
    return Object.freeze([...file.tasks]);
  }

  async flushNow(userId: string): Promise<void> {
    await this.inner.flush(userId);
  }

  async flushAll(): Promise<void> {
    await this.inner.flush();
  }

  private async loadFile(userId: string): Promise<TasksFileV2> {
    const row = await this.inner.get(userId, SINGLETON_KEY);
    if (row === null) return EMPTY_FILE;
    // The legacy decoder + write path already validated; trust the
    // disk shape here to avoid re-rejecting in-memory state that
    // pre-dates a stricter schema (matches old UserScopedJsonStore
    // caching semantics).
    try {
      const parsed = JSON.parse(row.payload_json) as TasksFileV2;
      if (parsed.version === 2 && Array.isArray(parsed.tasks)) return parsed;
    } catch {
      // fall through
    }
    return EMPTY_FILE;
  }

  private async mutateFile(
    userId: string,
    apply: (current: TasksFileV2) => TasksFileV2,
  ): Promise<void> {
    await this.withUserLock(userId, async () => {
      const current = await this.loadFile(userId);
      const next = apply(current);
      await this.inner.upsert(userId, {
        id: SINGLETON_KEY,
        payload_json: JSON.stringify(next),
      });
      await this.inner.flush(userId);
    });
  }

  private async withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.mutexByUser.get(userId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.mutexByUser.set(
      userId,
      next.catch(() => undefined),
    );
    return next;
  }
}
