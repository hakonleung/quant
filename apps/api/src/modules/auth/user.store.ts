/**
 * Parquet-backed registry of known users. One file per deployment at
 * `data/users/_meta/users.parquet`. The `_meta` prefix sits lexically
 * before any real userId so the file path cannot collide with a real
 * per-user directory (`data/users/${userId}/...`).
 *
 * Self-migration: legacy `data/users/_meta/users.json` is adopted on
 * first boot and renamed `.bak`.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';

import { DuckDBParquetRecordStore } from '../../common/storage/adapters/duckdb-parquet-record.store.js';
import type { RecordTableSpec } from '../../common/storage/ports/record-store.port.js';
import { AUTH_CONFIG, type AuthConfigShape } from './config/auth.config.js';

const UserRecordSchema = z
  .object({
    id: z.string().min(1),
    provider: z.union([
      z.literal('feishu'),
      z.literal('github'),
      z.literal('google'),
      z.literal('admin'),
    ]),
    externalId: z.string(),
    tenantKey: z.string().nullable(),
    displayName: z.string(),
    email: z.string().nullable(),
    avatarUrl: z.string().nullable(),
    createdAt: z.string(),
    lastLoginAt: z.string().nullable(),
  })
  .strict();

export type UserRecord = z.infer<typeof UserRecordSchema>;

export const USERS_TABLE_SPEC: RecordTableSpec<UserRecord> = {
  table: 'users',
  schema: UserRecordSchema,
  pk: (row) => row.id,
  columns: [
    { name: 'id', type: 'VARCHAR', nullable: false, primaryKey: true },
    { name: 'provider', type: 'VARCHAR', nullable: false },
    { name: 'externalId', type: 'VARCHAR', nullable: false },
    { name: 'tenantKey', type: 'VARCHAR' },
    { name: 'displayName', type: 'VARCHAR', nullable: false },
    { name: 'email', type: 'VARCHAR' },
    { name: 'avatarUrl', type: 'VARCHAR' },
    { name: 'createdAt', type: 'VARCHAR', nullable: false },
    { name: 'lastLoginAt', type: 'VARCHAR' },
  ],
};

const LegacyUsersFileSchema = z.object({ users: z.array(UserRecordSchema) }).strict();

@Injectable()
export class UserStore implements OnModuleInit {
  private readonly logger = new Logger(UserStore.name);
  private readonly users = new Map<string, UserRecord>();
  private mutexChain: Promise<unknown> = Promise.resolve();
  private loaded = false;
  private readonly inner: DuckDBParquetRecordStore<UserRecord>;
  private readonly dataDir: string;

  constructor(@Inject(AUTH_CONFIG) private readonly cfg: AuthConfigShape) {
    this.dataDir = path.join(cfg.dataRoot, 'users', '_meta');
    this.inner = new DuckDBParquetRecordStore<UserRecord>({
      dataRoot: this.dataDir,
      spec: USERS_TABLE_SPEC,
    });
  }

  async onModuleInit(): Promise<void> {
    await this.load();
  }

  async load(): Promise<void> {
    return this.withLock(async () => {
      if (this.loaded) return;
      await this.adoptLegacyIfNeeded();
      const rows = await this.inner.list();
      for (const u of rows) this.users.set(u.id, u);
      this.loaded = true;
      this.logger.log(`loaded ${String(this.users.size)} users`);
    });
  }

  get(id: string): UserRecord | null {
    return this.users.get(id) ?? null;
  }

  list(): readonly UserRecord[] {
    return Array.from(this.users.values()).sort((a, b) => a.id.localeCompare(b.id));
  }

  async upsert(record: UserRecord): Promise<UserRecord> {
    return this.withLock(async () => {
      this.users.set(record.id, record);
      await this.inner.upsert(record);
      await this.inner.flush();
      return record;
    });
  }

  /** Touch `lastLoginAt`; idempotent — safe to call on every Web login. */
  async touchLogin(id: string, when: string): Promise<void> {
    await this.withLock(async () => {
      const existing = this.users.get(id);
      if (existing === undefined) return;
      const next: UserRecord = { ...existing, lastLoginAt: when };
      this.users.set(id, next);
      await this.inner.upsert(next);
      await this.inner.flush();
    });
  }

  /** Seed the synthetic `admin` record used in `AUTH_MODE=disabled`. */
  async ensureAdminSeed(): Promise<void> {
    await this.withLock(async () => {
      const id = this.cfg.adminUserId;
      if (this.users.has(id)) return;
      const now = new Date().toISOString();
      const seed: UserRecord = {
        id,
        provider: 'admin',
        externalId: id,
        tenantKey: null,
        displayName: 'admin',
        email: null,
        avatarUrl: null,
        createdAt: now,
        lastLoginAt: now,
      };
      this.users.set(id, seed);
      await this.inner.upsert(seed);
      await this.inner.flush();
    });
  }

  /**
   * Adopt the legacy `users.json` when the parquet file is absent.
   * Reads + validates + bulk-upserts into the new store, then renames
   * the JSON to `.bak` for one-release rollback.
   */
  private async adoptLegacyIfNeeded(): Promise<void> {
    const parquet = path.join(this.dataDir, 'users.parquet');
    const legacy = path.join(this.dataDir, 'users.json');
    if (await fileExists(parquet)) return;
    if (!(await fileExists(legacy))) return;
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(legacy, 'utf8'));
    } catch (err: unknown) {
      this.logger.warn(`users.json parse failed during migration: ${String(err)}`);
      return;
    }
    const parsed = LegacyUsersFileSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.warn(`users.json failed validation during migration: ${parsed.error.message}`);
      return;
    }
    if (parsed.data.users.length > 0) {
      await this.inner.upsertMany(parsed.data.users);
      await this.inner.flush();
    }
    await fs.rename(legacy, `${legacy}.bak`);
    this.logger.log(
      `users.json migrated → users.parquet (${String(parsed.data.users.length)} rows)`,
    );
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutexChain.then(fn, fn);
    this.mutexChain = next.catch(() => undefined);
    return next;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
