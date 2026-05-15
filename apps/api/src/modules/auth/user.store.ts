/**
 * Parquet-backed registry of known users. One file per deployment at
 * `data/all_users.parquet`. Lives flat at the data root because it's
 * a system-wide index — not per-user state.
 */

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
  table: 'all_users',
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

@Injectable()
export class UserStore implements OnModuleInit {
  private readonly logger = new Logger(UserStore.name);
  private readonly users = new Map<string, UserRecord>();
  private mutexChain: Promise<unknown> = Promise.resolve();
  private loaded = false;
  private readonly inner: DuckDBParquetRecordStore<UserRecord>;

  constructor(@Inject(AUTH_CONFIG) private readonly cfg: AuthConfigShape) {
    this.inner = new DuckDBParquetRecordStore<UserRecord>({
      dataRoot: cfg.dataRoot,
      spec: USERS_TABLE_SPEC,
    });
  }

  async onModuleInit(): Promise<void> {
    await this.load();
  }

  async load(): Promise<void> {
    return this.withLock(async () => {
      if (this.loaded) return;
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

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutexChain.then(fn, fn);
    this.mutexChain = next.catch(() => undefined);
    return next;
  }
}
