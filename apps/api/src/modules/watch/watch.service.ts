/**
 * CRUD + universe orchestration for Watch (`docs/modules/W-0-watch.md` §10).
 *
 * The scheduler talks to the same store directly (no service-layer call
 * needed) — this service is the controller's view.
 */

import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  newTraceId,
  QuantError,
  type StockBasic,
  type WatchGroup,
  type WatchMarket,
  type WatchTask,
} from '@quant/shared';
import { StockMetaService } from '../stock-meta/stock-meta.service.js';
import type { WatchGroupCreate, WatchTaskCreate, WatchTaskPatch } from './dto/watch.dto.js';
import { WatchGroupStore } from './watch-group.store.js';
import { WatchTaskStore } from './watch-task.store.js';
import { WatchUniverseStore } from './watch-universe.store.js';
import { WATCH_QUOTE_PORT, type WatchQuotePort } from './domain/watch-port.js';

@Injectable()
export class WatchService implements OnModuleInit {
  private readonly logger = new Logger(WatchService.name);

  constructor(
    @Inject(WatchTaskStore) private readonly tasks: WatchTaskStore,
    @Inject(WatchGroupStore) private readonly groups: WatchGroupStore,
    @Inject(WatchUniverseStore) private readonly universe: WatchUniverseStore,
    @Inject(WATCH_QUOTE_PORT) private readonly port: WatchQuotePort,
    @Inject(StockMetaService) private readonly stockMeta: StockMetaService,
  ) {}

  /**
   * Lifecycle hook — load group state and seed any groups missing for
   * legacy tasks. The task store itself is loaded by the scheduler;
   * `tasks.load()` is idempotent (the `loaded` flag short-circuits)
   * so calling it here is safe even when the scheduler runs first.
   */
  async onModuleInit(): Promise<void> {
    await this.tasks.load();
    await this.groups.load();
    const seeded = await this.seedLegacyGroups();
    if (seeded > 0) {
      this.logger.log(`seeded ${String(seeded)} legacy watch groups`);
    }
  }

  list(): readonly WatchTask[] {
    return this.tasks.list();
  }

  listGroups(): readonly WatchGroup[] {
    return this.groups.list();
  }

  getGroup(name: string): WatchGroup {
    const g = this.groups.get(name);
    if (g === undefined) {
      throw new QuantError('NOT_FOUND', `watch group ${name} not found`, { name });
    }
    return g;
  }

  async createGroup(payload: WatchGroupCreate): Promise<WatchGroup> {
    if (this.groups.has(payload.name)) {
      throw new QuantError('WATCH_TASK_CONFLICT', `watch group ${payload.name} already exists`, {
        kind: 'group',
        name: payload.name,
      });
    }
    const group: WatchGroup = {
      name: payload.name,
      conditions: payload.conditions,
      intervalSec: payload.intervalSec,
      pushIntervalSec: payload.pushIntervalSec,
      createdAt: new Date().toISOString(),
    };
    await this.groups.upsert(group, false);
    return group;
  }

  /**
   * Cascade delete: drop every task that references this group, then
   * remove the group config. Order matters — tasks first so the
   * scheduler never sees a task whose group has vanished.
   */
  async deleteGroup(name: string): Promise<void> {
    if (!this.groups.has(name)) {
      throw new QuantError('NOT_FOUND', `watch group ${name} not found`, { name });
    }
    await this.tasks.deleteByGroup(name);
    await this.groups.delete(name);
  }

  /**
   * Seed legacy groups from any tasks that survived the schema migration
   * with synthesized `groupName`s but no matching entry in `groups.json`.
   * Idempotent — safe to run on every boot. Conditions / intervals are
   * copied from the first task that mentions the group.
   */
  async seedLegacyGroups(): Promise<number> {
    const seen = new Set<string>();
    let added = 0;
    for (const task of this.tasks.list()) {
      if (seen.has(task.groupName)) continue;
      seen.add(task.groupName);
      if (this.groups.has(task.groupName)) continue;
      await this.groups.upsert(
        {
          name: task.groupName,
          conditions: task.conditions,
          intervalSec: task.intervalSec,
          pushIntervalSec: task.pushIntervalSec,
          createdAt: task.createdAt,
        },
        false,
      );
      added += 1;
    }
    return added;
  }

  async create(payload: WatchTaskCreate): Promise<WatchTask> {
    const existing = this.tasks.get(payload.market, payload.code);
    if (existing !== undefined) {
      throw new QuantError(
        'WATCH_TASK_CONFLICT',
        `task already exists for ${payload.market}:${payload.code}`,
        { market: payload.market, code: payload.code },
      );
    }
    const group = this.groups.get(payload.groupName);
    if (group === undefined) {
      throw new QuantError(
        'NOT_FOUND',
        `watch group ${payload.groupName} not found; create it via POST /watch/groups first`,
        { kind: 'group', name: payload.groupName },
      );
    }
    const now = new Date().toISOString();
    const task: WatchTask = {
      market: payload.market,
      code: payload.code,
      name: payload.name,
      groupName: group.name,
      conditions: group.conditions,
      intervalSec: group.intervalSec,
      pushIntervalSec: group.pushIntervalSec,
      remaining: payload.remaining,
      notifySlack: payload.notifySlack,
      enabled: payload.enabled,
      createdAt: now,
      lastTickAt: null,
      lastPushAt: null,
      lastSampleAt: null,
      hitCount: 0,
      lastHitPrice: null,
    };
    await this.tasks.upsert(task, false);
    return task;
  }

  async patch(
    market: WatchTask['market'],
    code: string,
    payload: WatchTaskPatch,
  ): Promise<WatchTask> {
    const next = await this.tasks.patch(market, code, (current) => ({
      ...current,
      ...(payload.name !== undefined ? { name: payload.name } : {}),
      ...(payload.remaining !== undefined ? { remaining: payload.remaining } : {}),
      ...(payload.notifySlack !== undefined ? { notifySlack: payload.notifySlack } : {}),
      ...(payload.enabled !== undefined ? { enabled: payload.enabled } : {}),
    }));
    if (next === undefined) {
      throw new QuantError('NOT_FOUND', `watch task ${market}:${code} not found`, {
        market,
        code,
      });
    }
    return next;
  }

  async delete(market: WatchTask['market'], code: string): Promise<void> {
    const ok = await this.tasks.delete(market, code);
    if (!ok) {
      throw new QuantError('NOT_FOUND', `watch task ${market}:${code} not found`, {
        market,
        code,
      });
    }
  }

  async getUniverse(market: 'hk' | 'us'): Promise<readonly StockBasic[]> {
    return this.universe.load(market);
  }

  async refreshUniverse(market: 'hk' | 'us'): Promise<readonly StockBasic[]> {
    const traceId = newTraceId();
    const rows = await this.port.refreshUniverse(market, traceId);
    await this.universe.replace(market, rows);
    return rows;
  }

  /**
   * Resolve `(market, code)` to a `StockBasic` so the frontend can
   * confirm a ticker exists before posting a task. Throws
   * `WATCH_CODE_NOT_FOUND` (404) when the code is absent from the
   * source of truth for that market — A-share via stock-meta,
   * HK/US via the on-disk universe cache.
   */
  async lookup(market: WatchMarket, code: string): Promise<StockBasic> {
    if (market === 'a') return this.lookupA(code);
    return this.lookupHkUs(market, code);
  }

  private async lookupA(code: string): Promise<StockBasic> {
    const traceId = newTraceId();
    try {
      const meta = await this.stockMeta.get(code, traceId);
      return { market: 'a', code: meta.code, name: meta.name };
    } catch (err) {
      if (err instanceof QuantError && err.code === 'STOCK_NOT_FOUND') {
        throw new QuantError('WATCH_CODE_NOT_FOUND', `a-share code ${code} not found`, {
          market: 'a',
          code,
        });
      }
      throw err;
    }
  }

  private async lookupHkUs(market: 'hk' | 'us', code: string): Promise<StockBasic> {
    const rows = await this.universe.load(market);
    const hit = rows.find((r) => r.code === code);
    if (hit !== undefined) return hit;
    throw new QuantError(
      'WATCH_CODE_NOT_FOUND',
      `${market}-code ${code} not in cached universe; try POST /api/watch/universe/refresh`,
      { market, code },
    );
  }
}
