/**
 * `UserScopedRecordStore` backed by one `DuckDBParquetRecordStore` per
 * user. Each user lives at `data/users/{userId}/{table}.parquet`,
 * preserving the directory-level isolation the legacy
 * `UserScopedJsonStore` had (privacy + per-user `rm -rf` deletion).
 *
 * Memory bound: an LRU keeps at most `maxActiveUsers` per-user stores
 * resident. Eviction flushes the store, then closes its DuckDB
 * connection (via `discard()` below — currently we just drop the
 * reference; the GC closes the connection). For 100 active users × 4
 * user-scoped tables × small parquet, peak is well under 100MB resident.
 *
 * Self-migration: when a user's parquet file is absent AND a legacy
 * JSON file exists at the caller-supplied `legacyJsonPath(userId)`, the
 * JSON is loaded, decoded via `legacyDecode`, and written into the
 * record store on first access. The JSON is then renamed `.bak`. This
 * is the mirror of `BlacklistStore`'s self-migration and frees module
 * facades from re-implementing it.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { DuckDBParquetRecordStore } from './duckdb-parquet-record.store.js';
import type {
  RecordFilter,
  RecordKey,
  RecordTableSpec,
} from '../ports/record-store.port.js';
import type { UserScopedRecordStore } from '../ports/user-scoped-record-store.port.js';

export interface FileSystemUserScopedRecordStoreOptions<V, K extends RecordKey> {
  readonly dataRoot: string;
  readonly spec: RecordTableSpec<V, K>;
  /**
   * Computes the per-user storage directory. Defaults to
   * `users/${userId}` under `dataRoot`. Override if the legacy layout
   * used a different relative path.
   */
  readonly userDir?: (userId: string) => string;
  readonly maxActiveUsers?: number;
  readonly idleTtlMs?: number;
  /**
   * Optional legacy-JSON migration hook. When provided AND the user's
   * record-store parquet is absent on first access, the file at
   * `legacyJsonPath(userId)` is read, fed through `legacyDecode`, then
   * upserted into the new store. The legacy file is renamed `.bak`
   * after a successful migration.
   */
  readonly legacyJsonPath?: (userId: string) => string;
  readonly legacyDecode?: (raw: unknown) => readonly V[];
  readonly logger?: { warn: (msg: string) => void; log?: (msg: string) => void };
}

const DEFAULT_MAX_ACTIVE_USERS = 100;
const DEFAULT_IDLE_TTL_MS = 30 * 60 * 1000;

interface UserSlot<V, K extends RecordKey> {
  store: DuckDBParquetRecordStore<V, K>;
  lastTouchedAt: number;
  migrated: boolean;
}

export class FileSystemUserScopedRecordStore<V, K extends RecordKey = string>
  implements UserScopedRecordStore<V, K>
{
  private readonly slots = new Map<string, UserSlot<V, K>>();
  private readonly maxActiveUsers: number;
  private readonly idleTtlMs: number;
  private readonly logger: { warn: (m: string) => void; log?: (m: string) => void };
  private readonly userDir: (userId: string) => string;
  private now: () => number = () => Date.now();

  constructor(private readonly opts: FileSystemUserScopedRecordStoreOptions<V, K>) {
    this.maxActiveUsers = opts.maxActiveUsers ?? DEFAULT_MAX_ACTIVE_USERS;
    this.idleTtlMs = opts.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.logger = opts.logger ?? { warn: () => undefined };
    this.userDir = opts.userDir ?? ((uid) => path.join('users', uid));
  }

  /** Visible for tests — inject a frozen clock. */
  withClock(now: () => number): this {
    this.now = now;
    return this;
  }

  async get(userId: string, key: K): Promise<V | null> {
    const slot = await this.ensure(userId);
    return slot.store.get(key);
  }

  async getMany(userId: string, keys: readonly K[]): Promise<readonly V[]> {
    const slot = await this.ensure(userId);
    return slot.store.getMany(keys);
  }

  async list(userId: string, filter?: RecordFilter<V>): Promise<readonly V[]> {
    const slot = await this.ensure(userId);
    return slot.store.list(filter);
  }

  async upsert(userId: string, value: V): Promise<void> {
    const slot = await this.ensure(userId);
    await slot.store.upsert(value);
  }

  async upsertMany(userId: string, values: readonly V[]): Promise<void> {
    const slot = await this.ensure(userId);
    await slot.store.upsertMany(values);
  }

  async delete(userId: string, key: K): Promise<boolean> {
    const slot = await this.ensure(userId);
    return slot.store.delete(key);
  }

  async deleteMany(userId: string, keys: readonly K[]): Promise<number> {
    const slot = await this.ensure(userId);
    return slot.store.deleteMany(keys);
  }

  async count(userId: string, filter?: RecordFilter<V>): Promise<number> {
    const slot = await this.ensure(userId);
    return slot.store.count(filter);
  }

  async purge(userId: string): Promise<void> {
    const slot = await this.ensure(userId);
    const all = await slot.store.list();
    if (all.length === 0) return;
    const keys = all.map((v) => this.opts.spec.pk(v));
    await slot.store.deleteMany(keys);
    await slot.store.flush();
  }

  async flush(userId?: string): Promise<void> {
    if (userId !== undefined) {
      const slot = this.slots.get(userId);
      if (slot !== undefined) await slot.store.flush();
      return;
    }
    for (const slot of this.slots.values()) {
      await slot.store.flush();
    }
  }

  private async ensure(userId: string): Promise<UserSlot<V, K>> {
    let slot = this.slots.get(userId);
    if (slot !== undefined) {
      slot.lastTouchedAt = this.now();
      return slot;
    }
    const userRoot = path.join(this.opts.dataRoot, this.userDir(userId));
    await fs.mkdir(userRoot, { recursive: true });
    const store = new DuckDBParquetRecordStore<V, K>({
      dataRoot: userRoot,
      spec: this.opts.spec,
    });
    slot = { store, lastTouchedAt: this.now(), migrated: false };
    this.slots.set(userId, slot);
    await this.migrateLegacyIfNeeded(userId, slot, userRoot);
    await this.evictIdleAndOverflow(userId);
    return slot;
  }

  private async migrateLegacyIfNeeded(
    userId: string,
    slot: UserSlot<V, K>,
    userRoot: string,
  ): Promise<void> {
    if (slot.migrated) return;
    slot.migrated = true;
    const parquetPath = path.join(userRoot, `${this.opts.spec.table}.parquet`);
    const parquetExists = await fileExists(parquetPath);
    if (parquetExists) return;
    if (this.opts.legacyJsonPath === undefined || this.opts.legacyDecode === undefined) return;
    const legacyPath = this.opts.legacyJsonPath(userId);
    let raw: string;
    try {
      raw = await fs.readFile(legacyPath, 'utf8');
    } catch {
      return; // no legacy file
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      this.logger.warn(
        `legacy json at ${legacyPath} malformed, ignoring: ${String(err)}`,
      );
      return;
    }
    let decoded: readonly V[];
    try {
      decoded = this.opts.legacyDecode(parsed);
    } catch (err) {
      this.logger.warn(
        `legacy json at ${legacyPath} failed decode, ignoring: ${String(err)}`,
      );
      return;
    }
    if (decoded.length > 0) {
      await slot.store.upsertMany(decoded);
      await slot.store.flush();
    }
    try {
      await fs.rename(legacyPath, `${legacyPath}.bak`);
    } catch (err) {
      this.logger.warn(
        `could not rename legacy ${legacyPath} to .bak: ${String(err)}`,
      );
    }
    this.logger.log?.(
      `migrated legacy json ${legacyPath} → record store user=${userId} rows=${String(decoded.length)}`,
    );
  }

  private async evictIdleAndOverflow(keepUserId: string): Promise<void> {
    const now = this.now();
    const toEvict: string[] = [];
    for (const [id, slot] of this.slots) {
      if (id === keepUserId) continue;
      if (now - slot.lastTouchedAt >= this.idleTtlMs) toEvict.push(id);
    }
    for (const id of toEvict) await this.evictSlot(id);
    if (this.slots.size <= this.maxActiveUsers) return;
    const candidates = Array.from(this.slots.entries())
      .filter(([id]) => id !== keepUserId)
      .sort((a, b) => a[1].lastTouchedAt - b[1].lastTouchedAt);
    while (this.slots.size > this.maxActiveUsers && candidates.length > 0) {
      const next = candidates.shift();
      if (next === undefined) break;
      await this.evictSlot(next[0]);
    }
  }

  private async evictSlot(userId: string): Promise<void> {
    const slot = this.slots.get(userId);
    if (slot === undefined) return;
    try {
      await slot.store.flush();
    } catch (err) {
      this.logger.warn(`flush on evict failed for user=${userId}: ${String(err)}`);
      return; // keep the slot — would lose data otherwise
    }
    this.slots.delete(userId);
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
