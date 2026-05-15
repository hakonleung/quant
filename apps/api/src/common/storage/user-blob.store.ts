/**
 * `UserBlobStore` — single-row payload_json parquet at
 * `data/users/{userId}/user.parquet` carrying the combined
 * watch / ledger / sysCfg state for one user.
 *
 * All read-modify-write goes through `update(userId, patch)` which
 * holds a per-user mutex while it loads, applies, validates, and
 * upserts. Mirrors the `WatchGroupStore` / `WatchTaskStore` singleton
 * pattern but consolidates into one file so we mutate one mutex per
 * user, not three.
 *
 * Self-migration: on first read for a user with no `user.parquet`, we
 * adopt any of the four legacy files that exist
 * (`watch_groups.parquet`, `watch_tasks.parquet`, `ledger.parquet`,
 * `sys-cfg/sys-cfg.json`), assemble a combined blob, write it, and
 * leave the originals in place — the standalone migrator script (run
 * once before this module ships in prod) renames them `.legacy/`.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { FileSystemUserScopedRecordStore } from './adapters/filesystem-user-scoped-record.store.js';
import type { RecordTableSpec } from './ports/record-store.port.js';
import type { UserScopedRecordStore } from './ports/user-scoped-record-store.port.js';
import {
  EMPTY_LEDGER_SLICE,
  EMPTY_USER_BLOB,
  EMPTY_WATCH_SLICE,
  EMPTY_WATCH_TASK_FILE,
  LedgerSliceSchema,
  UserBlobSchema,
  USER_BLOB_SCHEMA_VERSION,
  WatchSliceSchema,
  type LedgerSlice,
  type UserBlob,
  type WatchSlice,
} from './user-blob.types.js';
import { DEFAULT_SYS_CFG, SysCfgSchema, WatchGroupSchema, type SysCfg } from '@quant/shared';

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

/**
 * Source of truth for a user's legacy files. The `dataRoot` argument is
 * the same root every other store sees (`AuthConfigShape.dataRoot`).
 */
export interface LegacyUserPaths {
  readonly watchGroupsParquet: string;
  readonly watchTasksParquet: string;
  readonly ledgerParquet: string;
  readonly sysCfgJson: string;
}

export function legacyUserPaths(dataRoot: string, userId: string): LegacyUserPaths {
  const userDir = path.join(dataRoot, 'users', userId);
  return {
    watchGroupsParquet: path.join(userDir, 'watch_groups.parquet'),
    watchTasksParquet: path.join(userDir, 'watch_tasks.parquet'),
    ledgerParquet: path.join(userDir, 'ledger.parquet'),
    sysCfgJson: path.join(userDir, 'sys-cfg', 'sys-cfg.json'),
  };
}

export interface UserBlobStoreOptions {
  readonly dataRoot: string;
  readonly inner?: UserScopedRecordStore<UserBlobRow>;
  /** Override for tests. Defaults to reading the on-disk legacy layout. */
  readonly readLegacy?: (userId: string) => Promise<Partial<UserBlob>>;
  readonly logger?: { warn: (msg: string) => void; log?: (msg: string) => void };
}

export class UserBlobStore {
  private readonly inner: UserScopedRecordStore<UserBlobRow>;
  private readonly mutexByUser = new Map<string, Promise<unknown>>();
  private readonly migratedUsers = new Set<string>();
  private readonly readLegacyImpl: (userId: string) => Promise<Partial<UserBlob>>;
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
    this.readLegacyImpl = opts.readLegacy ?? defaultReadLegacy(opts.dataRoot);
  }

  async read(userId: string): Promise<UserBlob> {
    await this.ensureMigrated(userId);
    return this.loadOrEmpty(userId);
  }

  async update(
    userId: string,
    patch: (current: UserBlob) => UserBlob,
  ): Promise<UserBlob> {
    return this.withUserLock(userId, async () => {
      await this.ensureMigrated(userId);
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

  /**
   * Force the lazy-migration path on next access. Visible for tests.
   */
  resetMigrationCache(): void {
    this.migratedUsers.clear();
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
    if (typeof obj['schemaVersion'] !== 'number' || obj['schemaVersion'] !== USER_BLOB_SCHEMA_VERSION) {
      // Try a strict parse anyway in case it actually conforms — falls
      // through to empty if it doesn't.
      const strict = UserBlobSchema.safeParse(raw);
      if (strict.success) return strict.data;
      this.logger.warn(`user_blob_load_unknown_version userId=${userId}`);
      return structuredClone(EMPTY_USER_BLOB);
    }
    return raw as UserBlob;
  }

  private async ensureMigrated(userId: string): Promise<void> {
    if (this.migratedUsers.has(userId)) return;
    const existing = await this.inner.get(userId, SINGLETON_KEY);
    if (existing !== null) {
      this.migratedUsers.add(userId);
      return;
    }
    const slices = await this.readLegacyImpl(userId);
    if (
      slices.watch === undefined &&
      slices.ledger === undefined &&
      slices.sysCfg === undefined
    ) {
      this.migratedUsers.add(userId);
      return;
    }
    const blob: UserBlob = {
      schemaVersion: USER_BLOB_SCHEMA_VERSION,
      watch: slices.watch ?? structuredClone(EMPTY_WATCH_SLICE),
      ledger: slices.ledger ?? structuredClone(EMPTY_LEDGER_SLICE),
      sysCfg: slices.sysCfg ?? structuredClone(DEFAULT_SYS_CFG),
    };
    const validated = UserBlobSchema.parse(blob);
    await this.inner.upsert(userId, {
      id: SINGLETON_KEY,
      payload_json: JSON.stringify(validated),
    });
    await this.inner.flush(userId);
    this.migratedUsers.add(userId);
    this.logger.log?.(`user_blob_migrated_from_legacy userId=${userId}`);
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

// ── default legacy reader ────────────────────────────────────────────────

function defaultReadLegacy(dataRoot: string): (userId: string) => Promise<Partial<UserBlob>> {
  return async (userId) => {
    const paths = legacyUserPaths(dataRoot, userId);
    const sysCfg = await readSysCfgJson(paths.sysCfgJson);
    // The legacy parquet readers are intentionally NOT wired into the
    // default reader: lazy migration from a still-live parquet file
    // would race with the per-store mutex of the old WatchGroupStore /
    // WatchTaskStore / LedgerStore until those facades are flipped to
    // delegate here. The standalone `migrate-user-stores.ts` script
    // (run once with the API stopped) handles the parquet sweep.
    return sysCfg === undefined ? {} : { sysCfg };
  };
}

async function readSysCfgJson(file: string): Promise<SysCfg | undefined> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = SysCfgSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

// ── slice helpers — re-used by facades and the migrator ──────────────────

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
