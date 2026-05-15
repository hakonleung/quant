/**
 * CRUD + universe orchestration for Watch (`docs/modules/W-0-watch.md` §10).
 *
 * Every public method takes the userId; the scheduler iterates known
 * users to build its tick set, and the controller derives the userId
 * from `@CurrentUser()`.
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

import { UserStore } from '../auth/user.store.js';
import { StockMetaService } from '../stock-meta/stock-meta.service.js';
import type {
  WatchGroupCreate,
  WatchGroupPatch,
  WatchTaskCreate,
  WatchTaskPatch,
} from './dto/watch.dto.js';
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
    @Inject(UserStore) private readonly users: UserStore,
  ) {}

  /**
   * Lifecycle hook — seed legacy groups for every known user. Idempotent;
   * a user with no legacy tasks contributes zero work.
   */
  async onModuleInit(): Promise<void> {
    let seeded = 0;
    for (const user of this.users.list()) {
      seeded += await this.seedLegacyGroups(user.id);
    }
    if (seeded > 0) {
      this.logger.log(`seeded ${String(seeded)} legacy watch groups across users`);
    }
  }

  list(userId: string): Promise<readonly WatchTask[]> {
    return this.tasks.list(userId);
  }

  listGroups(userId: string): Promise<readonly WatchGroup[]> {
    return this.groups.list(userId);
  }

  async getGroup(userId: string, name: string): Promise<WatchGroup> {
    const g = await this.groups.get(userId, name);
    if (g === undefined) {
      throw new QuantError('NOT_FOUND', `watch group ${name} not found`, { name });
    }
    return g;
  }

  async createGroup(userId: string, payload: WatchGroupCreate): Promise<WatchGroup> {
    if (await this.groups.has(userId, payload.name)) {
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
      enabled: payload.enabled,
      createdAt: new Date().toISOString(),
    };
    await this.groups.upsert(userId, group, false);
    return group;
  }

  async patchGroup(userId: string, name: string, payload: WatchGroupPatch): Promise<WatchGroup> {
    const next = await this.groups.patch(userId, name, (g) => ({
      ...g,
      ...(payload.enabled !== undefined ? { enabled: payload.enabled } : {}),
    }));
    if (next === undefined) {
      throw new QuantError('NOT_FOUND', `watch group ${name} not found`, { name });
    }
    return next;
  }

  async deleteGroup(userId: string, name: string): Promise<void> {
    if (!(await this.groups.has(userId, name))) {
      throw new QuantError('NOT_FOUND', `watch group ${name} not found`, { name });
    }
    await this.tasks.deleteByGroup(userId, name);
    await this.groups.delete(userId, name);
  }

  async seedLegacyGroups(userId: string): Promise<number> {
    const seen = new Set<string>();
    let added = 0;
    for (const task of await this.tasks.list(userId)) {
      if (seen.has(task.groupName)) continue;
      seen.add(task.groupName);
      if (await this.groups.has(userId, task.groupName)) continue;
      await this.groups.upsert(
        userId,
        {
          name: task.groupName,
          conditions: task.conditions,
          intervalSec: task.intervalSec,
          pushIntervalSec: task.pushIntervalSec,
          enabled: true,
          createdAt: task.createdAt,
        },
        false,
      );
      added += 1;
    }
    return added;
  }

  async create(userId: string, payload: WatchTaskCreate): Promise<WatchTask> {
    const existing = await this.tasks.get(userId, payload.market, payload.code);
    if (existing !== undefined) {
      throw new QuantError(
        'WATCH_TASK_CONFLICT',
        `task already exists for ${payload.market}:${payload.code}`,
        { market: payload.market, code: payload.code },
      );
    }
    const group = await this.groups.get(userId, payload.groupName);
    if (group === undefined) {
      throw new QuantError(
        'NOT_FOUND',
        `watch group ${payload.groupName} not found; create it via POST /watch/groups first`,
        { kind: 'group', name: payload.groupName },
      );
    }
    const now = new Date().toISOString();
    // idx is auto-assigned by the store; build without it
    const taskData = {
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
    } satisfies Omit<WatchTask, 'idx'>;
    return this.tasks.upsert(userId, taskData, false);
  }

  async patch(
    userId: string,
    market: WatchTask['market'],
    code: string,
    payload: WatchTaskPatch,
  ): Promise<WatchTask> {
    const next = await this.tasks.patch(userId, market, code, (current) => ({
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

  async delete(userId: string, market: WatchTask['market'], code: string): Promise<void> {
    const ok = await this.tasks.delete(userId, market, code);
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
