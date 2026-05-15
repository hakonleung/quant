/**
 * `UserBlobStore` — single-row payload_json parquet at
 * `data/users/{userId}/user.parquet` carrying the combined
 * watch / ledger / sysCfg state for one user.
 *
 * All read-modify-write goes through `update(userId, patch)` which
 * holds a per-user mutex while it loads, applies, and upserts.
 * Mirrors the prior per-store singleton pattern but consolidates
 * into one file so we mutate one mutex per user, not three.
 */

import { z } from 'zod';

import { FileSystemUserScopedRecordStore } from './adapters/filesystem-user-scoped-record.store.js';
import type { RecordTableSpec } from './ports/record-store.port.js';
import type { UserScopedRecordStore } from './ports/user-scoped-record-store.port.js';
import {
  EMPTY_USER_BLOB,
  LedgerSliceSchema,
  UserBlobSchema,
  USER_BLOB_SCHEMA_VERSION,
  WatchSliceSchema,
  EMPTY_WATCH_TASK_FILE,
  type LedgerSlice,
  type UserBlob,
  type WatchSlice,
} from './user-blob.types.js';
import { WatchGroupSchema } from '@quant/shared';

const SINGLETON_KEY = 'singleton' as const;

export interface UserBlobRow {
  readonly id: typeof SINGLETON_KEY;
  readonly payload_json: string;
}

export const UserBlobRowSchema = z.object({
  id: z.literal(SINGLETON_KEY),
  payload_json: z.string(),
});

export const USER_BLOB_TABLE_SPEC: RecordTableSpec<UserBlobRow> = {
  table: 'user',
  schema: UserBlobRowSchema,
  pk: (row) => row.id,
  columns: [
    { name: 'id', type: 'VARCHAR', nullable: false, primaryKey: true },
    { name: 'payload_json', type: 'VARCHAR', nullable: false },
  ],
};

export interface UserBlobStoreOptions {
  readonly dataRoot: string;
  readonly inner?: UserScopedRecordStore<UserBlobRow>;
  readonly logger?: { warn: (msg: string) => void; log?: (msg: string) => void };
}

export class UserBlobStore {
  private readonly inner: UserScopedRecordStore<UserBlobRow>;
  private readonly mutexByUser = new Map<string, Promise<unknown>>();
  private readonly logger: { warn: (m: string) => void; log?: (m: string) => void };

  constructor(opts: UserBlobStoreOptions) {
    this.logger = opts.logger ?? { warn: () => undefined };
    this.inner =
      opts.inner ??
      new FileSystemUserScopedRecordStore<UserBlobRow>({
        dataRoot: opts.dataRoot,
        spec: USER_BLOB_TABLE_SPEC,
        logger: this.logger,
      });
  }

  async read(userId: string): Promise<UserBlob> {
    return this.loadOrEmpty(userId);
  }

  async update(userId: string, patch: (current: UserBlob) => UserBlob): Promise<UserBlob> {
    return this.withUserLock(userId, async () => {
      const current = await this.loadOrEmpty(userId);
      const next = patch(current);
      // No strict re-validation here. Boundary validation runs at the
      // API layer (WatchTaskCreateSchema, LedgerEntrySchema, …); the
      // store trusts what it's handed. Re-running a strict parse would
      // reject in-flight fixtures that pre-date later schema tightening
      // (intervalSec.min, pct condition refinements) — the same trade-off
      // the prior per-store facades made on read.
      const checked = UserBlobSchema.safeParse(next);
      if (!checked.success) {
        this.logger.warn(
          `user_blob_write_loose userId=${userId} issues=${checked.error.issues.length}`,
        );
      }
      await this.inner.upsert(userId, {
        id: SINGLETON_KEY,
        payload_json: JSON.stringify(next),
      });
      await this.inner.flush(userId);
      return next;
    });
  }

  async flush(userId?: string): Promise<void> {
    await this.inner.flush(userId);
  }

  private async loadOrEmpty(userId: string): Promise<UserBlob> {
    const row = await this.inner.get(userId, SINGLETON_KEY);
    if (row === null) return structuredClone(EMPTY_USER_BLOB);
    let raw: unknown;
    try {
      raw = JSON.parse(row.payload_json);
    } catch (err: unknown) {
      this.logger.warn(`user_blob_load_parse_failed userId=${userId} err=${String(err)}`);
      return structuredClone(EMPTY_USER_BLOB);
    }
    if (raw === null || typeof raw !== 'object') {
      this.logger.warn(`user_blob_load_not_object userId=${userId}`);
      return structuredClone(EMPTY_USER_BLOB);
    }
    // Trust the round-trip: same trade-off the prior per-store facades
    // made on read (see WatchTaskStore.loadFile pre-refactor). Strict
    // re-validation here would silently drop tasks that pre-date later
    // schema tightening. Boundary validation owns correctness; the
    // store owns durability + structure only.
    const obj = raw as Record<string, unknown>;
    if (
      typeof obj['schemaVersion'] !== 'number' ||
      obj['schemaVersion'] !== USER_BLOB_SCHEMA_VERSION
    ) {
      // Try a strict parse anyway in case it actually conforms — falls
      // through to empty if it doesn't.
      const strict = UserBlobSchema.safeParse(raw);
      if (strict.success) return strict.data;
      this.logger.warn(`user_blob_load_unknown_version userId=${userId}`);
      return structuredClone(EMPTY_USER_BLOB);
    }
    return raw as UserBlob;
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

// ── slice helpers — kept for the migrator script (one-shot legacy adoption) ──

export function parseWatchSlice(raw: unknown): WatchSlice | undefined {
  const parsed = WatchSliceSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export function parseLedgerSlice(raw: unknown): LedgerSlice | undefined {
  const parsed = LedgerSliceSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export function parseWatchGroupsArray(raw: unknown): WatchSlice['groups'] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const parsed = z.array(WatchGroupSchema).safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export function buildWatchSlice(
  groups: WatchSlice['groups'] | undefined,
  tasksFile: WatchSlice['tasks'] | undefined,
): WatchSlice {
  return {
    groups: groups ?? [],
    tasks: tasksFile ?? structuredClone(EMPTY_WATCH_TASK_FILE),
  };
}
