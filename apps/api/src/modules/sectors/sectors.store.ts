/**
 * File-backed sectors store.
 *
 * Sectors are a *shared* resource: a single `data/sectors/sectors.json`
 * holds every user's sectors. Ownership is encoded by `createdBy` and
 * cross-user visibility by `published`. The store deliberately does not
 * partition by user — published sectors must be readable by everyone, so
 * a single file keeps the read path one stat.
 *
 * Atomicity: `tmp + rename`. A single mutex serialises read/write.
 *
 * Lazy migration: pre-ownership records are missing `createdBy`. On first
 * load we coerce them to the synthetic admin user (`AUTH_MODE=disabled`
 * default) and `published = false`. The migrated values land back on disk
 * the next time anything writes; reads remain pure (no implicit fsync).
 */

import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { QuantError, SectorsListSchema, type Sector } from '@quant/shared';
import { atomicWriteJson, readJsonOr } from '../watch/domain/atomic-json.js';

export const SECTORS_DATA_DIR = Symbol('SECTORS_DATA_DIR');

const LEGACY_OWNER_ID = 'admin';

@Injectable()
export class SectorsStore implements OnModuleInit {
  private readonly logger = new Logger(SectorsStore.name);
  private sectors: readonly Sector[] = [];
  private mutexChain: Promise<unknown> = Promise.resolve();
  private loaded = false;

  constructor(@Inject(SECTORS_DATA_DIR) private readonly dataDir: string) {}

  async onModuleInit(): Promise<void> {
    await this.load();
  }

  private get file(): string {
    return `${this.dataDir}/sectors.json`;
  }

  async load(): Promise<void> {
    return this.withLock(async () => {
      if (this.loaded) return;
      const raw = await readJsonOr<unknown>(this.file, []);
      const migrated = migrateLegacy(raw);
      const parsed = SectorsListSchema.safeParse(migrated);
      if (!parsed.success) {
        this.logger.warn(`sectors.json failed validation, starting empty: ${parsed.error.message}`);
        this.loaded = true;
        return;
      }
      this.sectors = parsed.data;
      this.loaded = true;
      this.logger.log(`loaded ${String(this.sectors.length)} sectors`);
    });
  }

  list(): readonly Sector[] {
    return this.sectors;
  }

  listVisibleTo(userId: string): readonly Sector[] {
    return this.sectors.filter((s) => s.createdBy === userId || s.published);
  }

  listOwnedBy(userId: string): readonly Sector[] {
    return this.sectors.filter((s) => s.createdBy === userId);
  }

  findById(id: string): Sector | null {
    return this.sectors.find((s) => s.id === id) ?? null;
  }

  /**
   * Replace only the sectors owned by `userId`. Sectors in `incoming` that
   * collide with another user's id are rejected as FORBIDDEN. Other users'
   * sectors (and `published` records owned by others) pass through
   * unchanged.
   */
  async replaceForUser(userId: string, incoming: readonly Sector[]): Promise<readonly Sector[]> {
    return this.withLock(async () => {
      const byId = new Map(this.sectors.map((s) => [s.id, s] as const));
      validateOwnership(userId, incoming, byId);
      const next: Sector[] = [];
      for (const s of this.sectors) {
        if (s.createdBy !== userId) next.push(s);
      }
      for (const candidate of incoming) {
        next.push(mergeForOwner(userId, candidate, byId.get(candidate.id)));
      }
      this.sectors = next;
      await atomicWriteJson(this.file, this.sectors);
      return this.sectors;
    });
  }

  /**
   * Upsert a single sector. Owner of an existing record is preserved; the
   * caller is responsible for owner checks (use `requireOwner` first).
   */
  async upsert(sector: Sector): Promise<Sector> {
    return this.withLock(async () => {
      const idx = this.sectors.findIndex((s) => s.id === sector.id);
      const next = [...this.sectors];
      if (idx >= 0) next[idx] = sector;
      else next.push(sector);
      this.sectors = next;
      await atomicWriteJson(this.file, this.sectors);
      return sector;
    });
  }

  async removeById(id: string): Promise<boolean> {
    return this.withLock(async () => {
      const idx = this.sectors.findIndex((s) => s.id === id);
      if (idx < 0) return false;
      const next = [...this.sectors];
      next.splice(idx, 1);
      this.sectors = next;
      await atomicWriteJson(this.file, this.sectors);
      return true;
    });
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutexChain.then(fn, fn);
    this.mutexChain = next.catch(() => undefined);
    return next;
  }
}

/**
 * Backfill `createdBy` / `published` on records that pre-date the
 * ownership model. Operates on raw JSON before zod validation so the
 * schema can require the new fields without breaking old data files.
 */
function migrateLegacy(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.map((item) => {
    if (typeof item !== 'object' || item === null) return item;
    const next: Record<string, unknown> = { ...(item as Record<string, unknown>) };
    if (typeof next['createdBy'] !== 'string' || next['createdBy'].length === 0) {
      next['createdBy'] = LEGACY_OWNER_ID;
    }
    if (typeof next['published'] !== 'boolean') {
      next['published'] = false;
    }
    return next;
  });
}

function validateOwnership(
  userId: string,
  incoming: readonly Sector[],
  byId: ReadonlyMap<string, Sector>,
): void {
  for (const candidate of incoming) {
    const existing = byId.get(candidate.id);
    if (existing && existing.createdBy !== userId) {
      throw new QuantError(
        'FORBIDDEN',
        `cannot edit sector ${candidate.id}: owned by ${existing.createdBy}`,
        { id: candidate.id, owner: existing.createdBy },
      );
    }
    if (candidate.createdBy && candidate.createdBy !== userId) {
      throw new QuantError(
        'FORBIDDEN',
        `cannot create sector ${candidate.id} on behalf of ${candidate.createdBy}`,
        { id: candidate.id },
      );
    }
  }
}

function mergeForOwner(
  userId: string,
  candidate: Sector,
  existing: Sector | undefined,
): Sector {
  return {
    ...candidate,
    createdBy: userId,
    published: existing?.published ?? candidate.published,
    ...(existing?.publishedAt !== undefined ? { publishedAt: existing.publishedAt } : {}),
  };
}
