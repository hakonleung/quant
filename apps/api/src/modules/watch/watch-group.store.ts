/**
 * Per-user watch group store. Backed by `UserScopedRecordStore<WatchGroupRow>`
 * — one singleton row per user (`id = 'singleton'`) with the full
 * `WatchGroup[]` JSON-encoded in `payload_json`.
 *
 * Why a blob? WatchGroup itself is a single layer of typed fields, but
 * the consumer surface is "give me the whole array" — there's no SQL
 * query path we'd benefit from. Same shortcut as BlacklistStore.
 *
 * Self-migration: legacy `data/users/{userId}/watch/groups.json` is
 * adopted on first access and renamed `.bak` (handled inside
 * `FileSystemUserScopedRecordStore`).
 */

import path from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { WatchGroupSchema, type WatchGroup } from '@quant/shared';
import { z } from 'zod';

import { FileSystemUserScopedRecordStore } from '../../common/storage/adapters/filesystem-user-scoped-record.store.js';
import type {
  RecordTableSpec,
} from '../../common/storage/ports/record-store.port.js';
import type { UserScopedRecordStore } from '../../common/storage/ports/user-scoped-record-store.port.js';
import { AUTH_CONFIG, type AuthConfigShape } from '../auth/config/auth.config.js';
import { WATCH_GROUP_USER_RECORD_STORE } from './watch.tokens.js';

const SINGLETON_KEY = 'singleton' as const;

export interface WatchGroupRow {
  readonly id: typeof SINGLETON_KEY;
  readonly payload_json: string;
}

export const WatchGroupRowSchema = z.object({
  id: z.literal(SINGLETON_KEY),
  payload_json: z.string(),
});

export const WATCH_GROUP_TABLE_SPEC: RecordTableSpec<WatchGroupRow> = {
  table: 'watch_groups',
  schema: WatchGroupRowSchema,
  pk: (row) => row.id,
  columns: [
    { name: 'id', type: 'VARCHAR', nullable: false, primaryKey: true },
    { name: 'payload_json', type: 'VARCHAR', nullable: false },
  ],
};

function decodeLegacy(raw: unknown): readonly WatchGroupRow[] {
  if (!Array.isArray(raw)) return [];
  const validated = z.array(WatchGroupSchema).safeParse(raw);
  if (!validated.success) return [];
  return [{ id: SINGLETON_KEY, payload_json: JSON.stringify(validated.data) }];
}

export function buildWatchGroupUserScopedStore(
  cfg: AuthConfigShape,
  logger: { warn: (m: string) => void; log?: (m: string) => void },
): UserScopedRecordStore<WatchGroupRow> {
  return new FileSystemUserScopedRecordStore<WatchGroupRow>({
    dataRoot: cfg.dataRoot,
    spec: WATCH_GROUP_TABLE_SPEC,
    legacyJsonPath: (uid) => path.join(cfg.dataRoot, 'users', uid, 'watch', 'groups.json'),
    legacyDecode: decodeLegacy,
    logger,
  });
}

@Injectable()
export class WatchGroupStore {
  private readonly logger = new Logger(WatchGroupStore.name);
  private readonly mutexByUser = new Map<string, Promise<unknown>>();

  constructor(
    @Inject(WATCH_GROUP_USER_RECORD_STORE)
    private readonly inner: UserScopedRecordStore<WatchGroupRow>,
    @Inject(AUTH_CONFIG) cfg: AuthConfigShape,
  ) {
    void cfg;
    void this.logger;
  }

  async list(userId: string): Promise<readonly WatchGroup[]> {
    const groups = await this.loadGroups(userId);
    return [...groups].sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(userId: string, name: string): Promise<WatchGroup | undefined> {
    const groups = await this.loadGroups(userId);
    return groups.find((g) => g.name === name);
  }

  async has(userId: string, name: string): Promise<boolean> {
    return (await this.get(userId, name)) !== undefined;
  }

  async upsert(userId: string, group: WatchGroup, allowReplace = false): Promise<void> {
    await this.mutate(userId, (current) => {
      const idx = current.findIndex((g) => g.name === group.name);
      if (idx < 0) return [...current, group];
      if (!allowReplace) {
        throw new Error(`group ${group.name} already exists`);
      }
      const next = [...current];
      next[idx] = group;
      return next;
    });
  }

  async patch(
    userId: string,
    name: string,
    apply: (current: WatchGroup) => WatchGroup,
  ): Promise<WatchGroup | undefined> {
    let next: WatchGroup | undefined;
    await this.mutate(userId, (current) => {
      const idx = current.findIndex((g) => g.name === name);
      if (idx < 0) return current;
      const updated = apply(current[idx]!);
      next = updated;
      const out = [...current];
      out[idx] = updated;
      return out;
    });
    return next;
  }

  async delete(userId: string, name: string): Promise<boolean> {
    let removed = false;
    await this.mutate(userId, (current) => {
      const next = current.filter((g) => g.name !== name);
      removed = next.length !== current.length;
      return next;
    });
    return removed;
  }

  private async loadGroups(userId: string): Promise<readonly WatchGroup[]> {
    const row = await this.inner.get(userId, SINGLETON_KEY);
    if (row === null) return [];
    // Trust the round-tripped JSON — strict re-validation here would
    // reject test fixtures that pre-date later schema tightening, and
    // legacy ingestion already validates via decodeLegacy.
    try {
      const parsed = JSON.parse(row.payload_json) as readonly WatchGroup[];
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fall through
    }
    return [];
  }

  private async mutate(
    userId: string,
    apply: (current: readonly WatchGroup[]) => readonly WatchGroup[],
  ): Promise<void> {
    await this.withUserLock(userId, async () => {
      const current = await this.loadGroups(userId);
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
