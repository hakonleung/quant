/**
 * Shared sectors store. Backed by `RecordStore<SectorRow>` — every
 * sector is one row `(id, payload_json)`. The in-memory `sectors`
 * array stays the canonical query surface (sync `list*` / `findById`);
 * parquet round-trips the whole list.
 *
 * Why a single `payload_json` column? The `Sector` DTO has nested
 * lists (`codes`), records (`evidence`), and AST objects (`screenPlan`,
 * `universePlan`) — none of which benefit from columnar projection
 * today and all of which the port can't express without `LIST<...>` /
 * `STRUCT<...>` support. JSON-in-VARCHAR is the same shortcut used for
 * `BlacklistStore`.
 *
 * Atomicity: a single mutex serialises read/write. After every
 * mutation we `flush()` the record store so the on-disk parquet
 * matches the in-memory state — sectors are tiny (10s of rows) so the
 * full rewrite is cheap.
 */

import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { QuantError, SectorsListSchema, type Sector } from '@quant/shared';
import { z } from 'zod';

import type { RecordStore, RecordTableSpec } from '../../common/storage/ports/record-store.port.js';

export const SECTORS_DATA_DIR = Symbol('SECTORS_DATA_DIR');
export const SECTORS_RECORD_STORE = Symbol('SECTORS_RECORD_STORE');

const SEQ_ID_RE = /^s(\d+)$/u;

export interface SectorRow {
  readonly id: string;
  readonly payload_json: string;
}

export const SectorRowSchema = z.object({
  id: z.string(),
  payload_json: z.string(),
});

export const SECTORS_TABLE_SPEC: RecordTableSpec<SectorRow> = {
  table: 'public_sectors',
  schema: SectorRowSchema,
  pk: (row) => row.id,
  columns: [
    { name: 'id', type: 'VARCHAR', nullable: false, primaryKey: true },
    { name: 'payload_json', type: 'VARCHAR', nullable: false },
  ],
};

@Injectable()
export class SectorsStore implements OnModuleInit {
  private readonly logger = new Logger(SectorsStore.name);
  private sectors: readonly Sector[] = [];
  private mutexChain: Promise<unknown> = Promise.resolve();
  private loaded = false;
  private nextSeq = 1;

  constructor(@Inject(SECTORS_RECORD_STORE) private readonly store: RecordStore<SectorRow>) {}

  async onModuleInit(): Promise<void> {
    await this.load();
  }

  async load(): Promise<void> {
    return this.withLock(async () => {
      if (this.loaded) return;
      const rows = await this.store.list({ orderBy: [{ column: 'id', dir: 'asc' }] });
      if (rows.length === 0) {
        this.adoptSectors([]);
        return;
      }
      const decoded = decodeRows(rows, this.logger);
      const { records, idMutated } = reseqIds(decoded);
      const parsed = SectorsListSchema.safeParse(records);
      if (!parsed.success) {
        this.logger.warn(`sectors rows failed validation, starting empty: ${parsed.error.message}`);
        this.adoptSectors([]);
        return;
      }
      this.adoptSectors(parsed.data);
      if (idMutated) {
        await this.persistAll();
        this.logger.log(
          `migrated sector ids to s{n}, rewrote ${String(this.sectors.length)} records`,
        );
      } else {
        this.logger.log(`loaded ${String(this.sectors.length)} sectors`);
      }
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

  async replaceForUser(userId: string, incoming: readonly Sector[]): Promise<readonly Sector[]> {
    return this.withLock(async () => {
      const byId = new Map(this.sectors.map((s) => [s.id, s] as const));
      const stamped: Sector[] = incoming.map((s) =>
        s.id.length > 0 && SEQ_ID_RE.test(s.id) ? s : { ...s, id: this.allocId() },
      );
      validateOwnership(userId, stamped, byId);
      const next: Sector[] = [];
      for (const s of this.sectors) {
        if (s.createdBy !== userId) next.push(s);
      }
      for (const candidate of stamped) {
        next.push(mergeForOwner(userId, candidate, byId.get(candidate.id)));
      }
      this.adoptSectors(next);
      await this.persistAll();
      return this.sectors;
    });
  }

  async upsert(sector: Sector): Promise<Sector> {
    return this.withLock(async () => {
      const id = sector.id.length > 0 && SEQ_ID_RE.test(sector.id) ? sector.id : this.allocId();
      const stamped: Sector = sector.id === id ? sector : { ...sector, id };
      const idx = this.sectors.findIndex((s) => s.id === id);
      const next = [...this.sectors];
      if (idx >= 0) next[idx] = stamped;
      else next.push(stamped);
      this.adoptSectors(next);
      await this.store.upsert(rowFor(stamped));
      await this.store.flush();
      return stamped;
    });
  }

  async removeById(id: string): Promise<boolean> {
    return this.withLock(async () => {
      const idx = this.sectors.findIndex((s) => s.id === id);
      if (idx < 0) return false;
      const next = [...this.sectors];
      next.splice(idx, 1);
      this.adoptSectors(next);
      await this.store.delete(id);
      await this.store.flush();
      return true;
    });
  }

  private adoptSectors(next: readonly Sector[]): void {
    this.sectors = next;
    this.nextSeq = computeNextSeq(next);
    this.loaded = true;
  }

  private async persistAll(): Promise<void> {
    const existing = await this.store.list();
    const targetIds = new Set(this.sectors.map((s) => s.id));
    const stale = existing.filter((row) => !targetIds.has(row.id)).map((row) => row.id);
    if (stale.length > 0) await this.store.deleteMany(stale);
    if (this.sectors.length > 0) {
      await this.store.upsertMany(this.sectors.map(rowFor));
    }
    await this.store.flush();
  }

  private allocId(): string {
    while (this.sectors.some((s) => s.id === `s${String(this.nextSeq)}`)) {
      this.nextSeq += 1;
    }
    const id = `s${String(this.nextSeq)}`;
    this.nextSeq += 1;
    return id;
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutexChain.then(fn, fn);
    this.mutexChain = next.catch(() => undefined);
    return next;
  }
}

function rowFor(sector: Sector): SectorRow {
  return { id: sector.id, payload_json: JSON.stringify(sector) };
}

function decodeRows(rows: readonly SectorRow[], logger: { warn: (m: string) => void }): unknown[] {
  const out: unknown[] = [];
  for (const row of rows) {
    try {
      out.push(JSON.parse(row.payload_json));
    } catch (err) {
      logger.warn(`sector ${row.id} payload malformed, dropping: ${String(err)}`);
    }
  }
  return out;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

function reseqIds(raw: unknown): { records: unknown; idMutated: boolean } {
  if (!Array.isArray(raw)) return { records: raw, idMutated: false };
  const taken = new Set<string>();
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = item['id'];
    if (typeof id === 'string' && SEQ_ID_RE.test(id)) taken.add(id);
  }
  let nextSeq = 1;
  const allocate = (): string => {
    while (taken.has(`s${String(nextSeq)}`)) nextSeq += 1;
    const id = `s${String(nextSeq)}`;
    taken.add(id);
    nextSeq += 1;
    return id;
  };
  let mutated = false;
  const out: unknown[] = raw.map((item: unknown) => {
    if (!isRecord(item)) return item;
    const id = item['id'];
    if (typeof id === 'string' && SEQ_ID_RE.test(id)) return item;
    mutated = true;
    return { ...item, id: allocate() };
  });
  return { records: out, idMutated: mutated };
}

function computeNextSeq(sectors: readonly Sector[]): number {
  let max = 0;
  for (const s of sectors) {
    const m = SEQ_ID_RE.exec(s.id);
    if (m === null) continue;
    const n = Number.parseInt(m[1] ?? '', 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
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

function mergeForOwner(userId: string, candidate: Sector, existing: Sector | undefined): Sector {
  return {
    ...candidate,
    createdBy: userId,
    published: existing?.published ?? candidate.published,
    ...(existing?.publishedAt !== undefined ? { publishedAt: existing.publishedAt } : {}),
  };
}
