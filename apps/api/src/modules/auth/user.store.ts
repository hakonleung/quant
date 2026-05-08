/**
 * JSON-backed registry of known users. One file per deployment at
 * `data/users/_meta/users.json`. The `_meta` prefix sits lexically
 * before any real userId so it cannot collide with a real per-user
 * directory (`data/users/${userId}/...`).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';

import { atomicWriteJson, readJsonOr } from '../watch/domain/atomic-json.js';
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

const UsersFileSchema = z.object({ users: z.array(UserRecordSchema) }).strict();
type UsersFile = z.infer<typeof UsersFileSchema>;

const EMPTY_FILE: UsersFile = { users: [] };

@Injectable()
export class UserStore implements OnModuleInit {
  private readonly logger = new Logger(UserStore.name);
  private readonly users = new Map<string, UserRecord>();
  private mutexChain: Promise<unknown> = Promise.resolve();
  private loaded = false;

  constructor(@Inject(AUTH_CONFIG) private readonly cfg: AuthConfigShape) {}

  async onModuleInit(): Promise<void> {
    await this.load();
  }

  private get file(): string {
    return path.join(this.cfg.dataRoot, 'users', '_meta', 'users.json');
  }

  async load(): Promise<void> {
    return this.withLock(async () => {
      if (this.loaded) return;
      const raw = await readJsonOr<unknown>(this.file, EMPTY_FILE);
      const parsed = UsersFileSchema.safeParse(raw);
      if (!parsed.success) {
        this.logger.warn(`users.json failed validation, starting empty: ${parsed.error.message}`);
      } else {
        for (const u of parsed.data.users) this.users.set(u.id, u);
      }
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
      await this.flush();
      return record;
    });
  }

  /** Touch `lastLoginAt`; idempotent — safe to call on every Web login. */
  async touchLogin(id: string, when: string): Promise<void> {
    await this.withLock(async () => {
      const existing = this.users.get(id);
      if (existing === undefined) return;
      this.users.set(id, { ...existing, lastLoginAt: when });
      await this.flush();
    });
  }

  /** Seed the synthetic `admin` record used in `AUTH_MODE=disabled`. */
  async ensureAdminSeed(): Promise<void> {
    await this.withLock(async () => {
      const id = this.cfg.adminUserId;
      if (this.users.has(id)) return;
      const now = new Date().toISOString();
      this.users.set(id, {
        id,
        provider: 'admin',
        externalId: id,
        tenantKey: null,
        displayName: 'admin',
        email: null,
        avatarUrl: null,
        createdAt: now,
        lastLoginAt: now,
      });
      await this.flush();
    });
  }

  private async flush(): Promise<void> {
    const data: UsersFile = { users: Array.from(this.users.values()) };
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await atomicWriteJson(this.file, data);
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutexChain.then(fn, fn);
    this.mutexChain = next.catch(() => undefined);
    return next;
  }
}
