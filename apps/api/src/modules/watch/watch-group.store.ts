/**
 * Per-user watch group store. Each user gets one
 * `data/users/{userId}/watch/groups.json`. Groups own
 * `conditions / intervalSec / pushIntervalSec`; tasks reference groups
 * by `groupName`.
 */

import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { WatchGroupSchema, type WatchGroup } from '@quant/shared';

import { UserScopedJsonStore } from '../../common/user-scoped-store.js';
import { AUTH_CONFIG, type AuthConfigShape } from '../auth/config/auth.config.js';

const GroupsFileSchema = z.array(WatchGroupSchema);

@Injectable()
export class WatchGroupStore {
  private readonly logger = new Logger(WatchGroupStore.name);
  private readonly inner: UserScopedJsonStore<WatchGroup[]>;

  constructor(@Inject(AUTH_CONFIG) cfg: AuthConfigShape) {
    this.inner = new UserScopedJsonStore<WatchGroup[]>(cfg.dataRoot, {
      relativePath: (uid) => `users/${uid}/watch/groups.json`,
      schema: GroupsFileSchema,
      fallback: () => [],
      logger: this.logger,
    });
  }

  async list(userId: string): Promise<readonly WatchGroup[]> {
    const arr = await this.inner.snapshot(userId);
    return [...arr].sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(userId: string, name: string): Promise<WatchGroup | undefined> {
    const arr = await this.inner.snapshot(userId);
    return arr.find((g) => g.name === name);
  }

  async has(userId: string, name: string): Promise<boolean> {
    return (await this.get(userId, name)) !== undefined;
  }

  async upsert(userId: string, group: WatchGroup, allowReplace = false): Promise<void> {
    await this.inner.mutate(userId, (current) => {
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

  async delete(userId: string, name: string): Promise<boolean> {
    let removed = false;
    await this.inner.mutate(userId, (current) => {
      const next = current.filter((g) => g.name !== name);
      removed = next.length !== current.length;
      return next;
    });
    return removed;
  }
}
