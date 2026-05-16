/**
 * `StockMetaPort` adapter that reads the Python-written
 * `data/stock_metas.parquet` directly via DuckDB and caches the whole
 * universe in-process.
 *
 * The Python side owns the writer (post-kline-sync projector emits
 * meta + persisted metrics into a single file). NestJS only reads, so
 * we skip the Flight round-trip entirely: cold load scans ~5500 rows
 * once, then every subsequent `getOne` / `listSnapshots` / etc. is a
 * `Map.get` against the in-memory snapshot.
 *
 * Invalidation: TTL (60s) + parquet mtime check. The kline-sync cron
 * runs once per trading day, so 60s SWR is comfortably tighter than
 * upstream cadence; the mtime check makes manual refreshes (e.g. dev
 * `python -m quant_rpc.tools.refresh`) visible without restarting Nest.
 */

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { DuckDBConnection } from '@duckdb/node-api';
import { DuckDBInstance } from '@duckdb/node-api';
import {
  QuarterlyFinancialsSchema,
  StockMetaDtoSchema,
  StockSnapshotDtoSchema,
  type QuarterlyFinancials,
  type StockMetaDto,
  type StockSnapshotDto,
} from '@quant/shared';

import type { StockMetaPort } from './domain/stock-meta-port.js';

export const STOCK_META_DATA_DIR = Symbol('STOCK_META_DATA_DIR');

const META_FILE = 'stock_metas.parquet';
const CACHE_TTL_MS = 60_000;

interface Snapshot {
  readonly metas: ReadonlyMap<string, StockMetaDto>;
  readonly snapshots: ReadonlyMap<string, StockSnapshotDto>;
  readonly sortedAll: readonly StockMetaDto[];
  readonly byIndustry: ReadonlyMap<string, readonly StockMetaDto[]>;
}

@Injectable()
export class LocalStockMetaAdapter implements StockMetaPort {
  private readonly logger = new Logger(LocalStockMetaAdapter.name);
  private readonly filePath: string;
  private snapshot: Snapshot | null = null;
  private loadedAtMs = 0;
  private loadedMtimeMs = -1;
  private inflight: Promise<Snapshot> | null = null;
  private connPromise: Promise<DuckDBConnection> | null = null;

  constructor(@Inject(STOCK_META_DATA_DIR) dataRoot: string) {
    this.filePath = join(dataRoot, META_FILE);
  }

  async getOne(code: string): Promise<StockMetaDto | null> {
    const snap = await this.fresh();
    return snap.metas.get(code) ?? null;
  }

  async getBatch(codes: readonly string[]): Promise<readonly StockMetaDto[]> {
    if (codes.length === 0) return [];
    const snap = await this.fresh();
    const seen = new Set<string>();
    const out: StockMetaDto[] = [];
    for (const c of codes) {
      if (seen.has(c)) continue;
      seen.add(c);
      const m = snap.metas.get(c);
      if (m !== undefined) out.push(m);
    }
    return out;
  }

  async listByIndustry(swL2: string): Promise<readonly StockMetaDto[]> {
    const snap = await this.fresh();
    return snap.byIndustry.get(swL2) ?? [];
  }

  async listAll(): Promise<readonly StockMetaDto[]> {
    const snap = await this.fresh();
    return snap.sortedAll;
  }

  async listSnapshots(codes: readonly string[]): Promise<readonly StockSnapshotDto[]> {
    const snap = await this.fresh();
    if (codes.length === 0) {
      const out: StockSnapshotDto[] = [];
      for (const m of snap.sortedAll) {
        const s = snap.snapshots.get(m.code);
        if (s !== undefined) out.push(s);
      }
      return out;
    }
    const seen = new Set<string>();
    const out: StockSnapshotDto[] = [];
    for (const c of codes) {
      if (seen.has(c)) continue;
      seen.add(c);
      const s = snap.snapshots.get(c);
      if (s !== undefined) out.push(s);
    }
    return out;
  }

  /** Visible for tests / explicit refresh hooks. */
  invalidate(): void {
    this.snapshot = null;
    this.loadedAtMs = 0;
    this.loadedMtimeMs = -1;
  }

  private async fresh(): Promise<Snapshot> {
    const now = Date.now();
    if (this.snapshot !== null && now - this.loadedAtMs < CACHE_TTL_MS) {
      return this.snapshot;
    }
    if (this.inflight !== null) return this.inflight;
    this.inflight = this.reload(now).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async reload(now: number): Promise<Snapshot> {
    let mtimeMs = -1;
    try {
      const st = await stat(this.filePath);
      mtimeMs = st.mtimeMs;
    } catch {
      // File absent: serve an empty universe rather than crashing the
      // process — matches the Python repo's "missing file is empty" rule.
      const empty: Snapshot = {
        metas: new Map(),
        snapshots: new Map(),
        sortedAll: [],
        byIndustry: new Map(),
      };
      this.snapshot = empty;
      this.loadedAtMs = now;
      this.loadedMtimeMs = -1;
      return empty;
    }
    if (this.snapshot !== null && mtimeMs === this.loadedMtimeMs) {
      this.loadedAtMs = now;
      return this.snapshot;
    }
    const snap = await this.scan();
    this.snapshot = snap;
    this.loadedAtMs = Date.now();
    this.loadedMtimeMs = mtimeMs;
    this.logger.log(
      `loaded stock_metas.parquet: ${snap.metas.size} codes, ${snap.byIndustry.size} industries`,
    );
    return snap;
  }

  private async scan(): Promise<Snapshot> {
    const conn = await this.connection();
    const sql = `SELECT * FROM read_parquet(${quoteLiteral(this.filePath)}) ORDER BY code ASC;`;
    const result = await conn.runAndReadAll(sql);
    const rows = result.getRowObjects();

    const metas = new Map<string, StockMetaDto>();
    const snapshots = new Map<string, StockSnapshotDto>();
    const sortedAll: StockMetaDto[] = [];
    const byIndustry = new Map<string, StockMetaDto[]>();

    for (const raw of rows) {
      const obj = raw as Record<string, unknown>;
      const meta = rowToMeta(obj);
      metas.set(meta.code, meta);
      sortedAll.push(meta);
      snapshots.set(meta.code, rowToSnapshot(meta, obj));
      for (const token of splitIndustries(meta.industries)) {
        let bucket = byIndustry.get(token);
        if (bucket === undefined) {
          bucket = [];
          byIndustry.set(token, bucket);
        }
        bucket.push(meta);
      }
    }

    return { metas, snapshots, sortedAll, byIndustry };
  }

  private connection(): Promise<DuckDBConnection> {
    if (this.connPromise === null) {
      this.connPromise = (async () => {
        const inst = await DuckDBInstance.create(':memory:');
        return inst.connect();
      })();
    }
    return this.connPromise;
  }
}

function rowToMeta(row: Record<string, unknown>): StockMetaDto {
  const candidate = {
    code: requireString(row['code'], 'code'),
    name: requireString(row['name'], 'name'),
    name_pinyin: requireString(row['name_pinyin'], 'name_pinyin'),
    industries: requireString(row['industries'], 'industries'),
    list_date: dateToIsoDate(row['list_date'], 'list_date'),
    float_pct: requireString(row['float_pct'], 'float_pct'),
    updated_at: dateToIsoUtc(row['updated_at'], 'updated_at'),
    total_share: optionalString(row['total_share']),
    float_share: optionalString(row['float_share']),
    net_assets: optionalString(row['net_assets']),
    net_assets_period: optionalIsoDate(row['net_assets_period']),
    quarterlies: parseQuarterlies(row['quarterlies_json']),
    financials_updated_at: optionalIsoUtc(row['financials_updated_at']),
  };
  return StockMetaDtoSchema.parse(candidate);
}

function rowToSnapshot(meta: StockMetaDto, row: Record<string, unknown>): StockSnapshotDto {
  const candidate = {
    meta,
    price: optionalString(row['metrics_price']),
    asof: optionalIsoDate(row['metrics_asof']),
    derived: {
      mkt_cap: optionalString(row['mkt_cap']),
      float_mkt_cap: optionalString(row['float_mkt_cap']),
      pe_ttm: optionalString(row['pe_ttm']),
      pe_dynamic: optionalString(row['pe_dynamic']),
      pb: optionalString(row['pb']),
      peg: optionalString(row['peg']),
      gross_margin_ttm: optionalString(row['gross_margin_ttm']),
    },
    returns: {
      ret_1d: optionalString(row['ret_1d']),
      ret_5d: optionalString(row['ret_5d']),
      ret_10d: optionalString(row['ret_10d']),
      ret_20d: optionalString(row['ret_20d']),
      ret_90d: optionalString(row['ret_90d']),
      ret_250d: optionalString(row['ret_250d']),
    },
  };
  return StockSnapshotDtoSchema.parse(candidate);
}

function splitIndustries(joined: string): readonly string[] {
  if (joined.length === 0) return [];
  return joined.split(',').filter((s) => s.length > 0);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`local-stock-meta: ${field} must be string, got ${typeof value}`);
  }
  return value;
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value === '' ? null : value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  throw new Error(`local-stock-meta: optional decimal must be string-like, got ${typeof value}`);
}

function optionalIsoDate(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return dateToIsoDate(value, 'optional date');
}

function optionalIsoUtc(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return dateToIsoUtc(value, 'optional datetime');
}

function dateToIsoDate(value: unknown, field: string): string {
  const d = coerceDate(value, field);
  const yyyy = String(d.getUTCFullYear()).padStart(4, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function dateToIsoUtc(value: unknown, field: string): string {
  const d = coerceDate(value, field);
  return d.toISOString().replace(/Z$/, '+00:00');
}

function coerceDate(value: unknown, field: string): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'bigint') return new Date(Number(value));
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    if (typeof obj['micros'] === 'bigint') return new Date(Number(obj['micros']) / 1000);
    if (typeof obj['days'] === 'number') return new Date(obj['days'] * 86_400_000);
  }
  throw new Error(`local-stock-meta: ${field} must be Date-like, got ${typeof value}`);
}

function parseQuarterlies(value: unknown): readonly QuarterlyFinancials[] {
  if (value === undefined || value === null || value === '') return [];
  if (typeof value !== 'string') {
    throw new Error(`local-stock-meta: quarterlies_json must be string, got ${typeof value}`);
  }
  const raw: unknown = JSON.parse(value);
  if (!Array.isArray(raw)) {
    throw new Error('local-stock-meta: quarterlies_json must be a JSON array');
  }
  return raw.map((entry) => QuarterlyFinancialsSchema.parse(entry));
}

function quoteLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}
