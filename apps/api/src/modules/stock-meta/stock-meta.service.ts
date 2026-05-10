/**
 * Service layer over the {@link StockMetaPort}. The controller only
 * touches this class — port implementations stay swappable (Flight,
 * in-memory test fake, future direct-DB read).
 *
 * "Missing → typed error" is owned here so every HTTP route gets the same
 * 404 mapping via `QuantErrorFilter` (no per-controller branching).
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { QuantError, type StockMetaDto, type StockSnapshotDto } from '@quant/shared';
import { CLOCK, type Clock } from '../../common/clock.js';
import { STOCK_META_PORT, type StockMetaPort } from './domain/stock-meta-port.js';

/**
 * `listAll` is the heaviest read in the API: ~5500 rows × 8 nested
 * quarterlies → ~5 MB JSON, decoded from a 64 MB Arrow Flight payload.
 * It's also stateless and shared across users (market data, see
 * CLAUDE.md §2.9), so we hold a single in-process cached snapshot with
 * SWR semantics — fresh ≤ TTL, stale-but-served while a single
 * background revalidation runs. The Python side updates kline/meta on
 * a 15:15 BJT cron, so a 60 s TTL is comfortably tighter than the
 * upstream change cadence.
 */
const LIST_ALL_TTL_MS = 60_000;
const SNAPSHOT_ALL_TTL_MS = 60_000;

interface ListAllCacheEntry {
  readonly value: readonly StockMetaDto[];
  readonly fetchedAt: number;
}

interface SnapshotAllCacheEntry {
  readonly value: readonly StockSnapshotDto[];
  readonly fetchedAt: number;
}

@Injectable()
export class StockMetaService {
  private readonly logger = new Logger(StockMetaService.name);
  private listAllCache: ListAllCacheEntry | null = null;
  private listAllRevalidating: Promise<readonly StockMetaDto[]> | null = null;
  private snapshotAllCache: SnapshotAllCacheEntry | null = null;
  private snapshotAllRevalidating: Promise<readonly StockSnapshotDto[]> | null = null;

  constructor(
    @Inject(STOCK_META_PORT) private readonly port: StockMetaPort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async get(code: string, traceId: string): Promise<StockMetaDto> {
    const item = await this.port.getOne(code, traceId);
    if (item === null) {
      throw new QuantError('STOCK_NOT_FOUND', `no such stock: ${code}`, { code });
    }
    return item;
  }

  async getBatch(codes: readonly string[], traceId: string): Promise<readonly StockMetaDto[]> {
    if (codes.length === 0) return [];
    return this.port.getBatch(codes, traceId);
  }

  async listByIndustry(swL2: string, traceId: string): Promise<readonly StockMetaDto[]> {
    if (swL2.length === 0) {
      throw new QuantError('INVALID_ARGUMENT', 'sw_l2 must be non-empty');
    }
    return this.port.listByIndustry(swL2, traceId);
  }

  async listAll(traceId: string): Promise<readonly StockMetaDto[]> {
    const now = this.clock.now().getTime();
    const cached = this.listAllCache;
    if (cached !== null) {
      const age = now - cached.fetchedAt;
      if (age < LIST_ALL_TTL_MS) return cached.value;
      // Stale: serve cached value and kick off a single background refresh.
      if (this.listAllRevalidating === null) {
        this.listAllRevalidating = this.refreshListAll(traceId).finally(() => {
          this.listAllRevalidating = null;
        });
        // Swallow background refresh errors — old value stays valid.
        this.listAllRevalidating.catch((err: unknown) => {
          this.logger.warn(`stock-meta listAll background refresh failed: ${String(err)}`);
        });
      }
      return cached.value;
    }
    // Cold start: a single in-flight fetch, shared by concurrent callers.
    this.listAllRevalidating ??= this.refreshListAll(traceId).finally(() => {
      this.listAllRevalidating = null;
    });
    return this.listAllRevalidating;
  }

  /** Test/lifecycle helper — drops the cached snapshots. */
  clearListAllCache(): void {
    this.listAllCache = null;
    this.listAllRevalidating = null;
  }

  private async refreshListAll(traceId: string): Promise<readonly StockMetaDto[]> {
    const value = await this.port.listAll(traceId);
    this.listAllCache = { value, fetchedAt: this.clock.now().getTime() };
    return value;
  }

  async listSnapshots(
    codes: readonly string[],
    traceId: string,
  ): Promise<readonly StockSnapshotDto[]> {
    // Empty `codes` is **not** an error — it tells the Python Flight
    // server to expand to the full universe. The `kline/bulk` route uses
    // the same convention, and EQ.LIST's `All` sector relies on it to
    // avoid a 30 KB query string. Adapter / Python side enforces the
    // server-side cap.
    return this.port.listSnapshots(codes, traceId);
  }

  /**
   * Full-universe snapshot with SWR caching (60 s TTL). Used by IM
   * handlers that render stock tables — they filter the cached result
   * locally rather than issuing per-code Flight calls.
   */
  async snapshotAll(traceId: string): Promise<readonly StockSnapshotDto[]> {
    const now = this.clock.now().getTime();
    const cached = this.snapshotAllCache;
    if (cached !== null) {
      const age = now - cached.fetchedAt;
      if (age < SNAPSHOT_ALL_TTL_MS) return cached.value;
      if (this.snapshotAllRevalidating === null) {
        this.snapshotAllRevalidating = this.refreshSnapshotAll(traceId).finally(() => {
          this.snapshotAllRevalidating = null;
        });
        this.snapshotAllRevalidating.catch((err: unknown) => {
          this.logger.warn(`stock-meta snapshotAll background refresh failed: ${String(err)}`);
        });
      }
      return cached.value;
    }
    this.snapshotAllRevalidating ??= this.refreshSnapshotAll(traceId).finally(() => {
      this.snapshotAllRevalidating = null;
    });
    return this.snapshotAllRevalidating;
  }

  private async refreshSnapshotAll(traceId: string): Promise<readonly StockSnapshotDto[]> {
    const value = await this.port.listSnapshots([], traceId);
    this.snapshotAllCache = { value, fetchedAt: this.clock.now().getTime() };
    return value;
  }
}
