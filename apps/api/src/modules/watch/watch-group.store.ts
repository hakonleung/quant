/**
 * Per-user watch group facade. Reads/writes the `watch.groups` slice of
 * the consolidated `data/users/{uid}/user.parquet` via `UserBlobStore`.
 *
 * Public API matches the prior implementation so `WatchService`,
 * `WatchScheduler`, and the watch instruction handlers are untouched.
 *
 * Concurrency: the underlying `UserBlobStore.update` already holds a
 * per-user mutex, so we don't repeat one here.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { WatchGroup } from '@quant/shared';

import { UserBlobStore } from '../../common/storage/user-blob.store.js';

@Injectable()
export class WatchGroupStore {
  constructor(@Inject(UserBlobStore) private readonly blob: UserBlobStore) {}

  async list(userId: string): Promise<readonly WatchGroup[]> {
    const groups = (await this.blob.read(userId)).watch.groups;
    return [...groups].sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(userId: string, name: string): Promise<WatchGroup | undefined> {
    const groups = (await this.blob.read(userId)).watch.groups;
    return groups.find((g) => g.name === name);
  }

  async has(userId: string, name: string): Promise<boolean> {
    return (await this.get(userId, name)) !== undefined;
  }

  async upsert(userId: string, group: WatchGroup, allowReplace = false): Promise<void> {
    await this.blob.update(userId, (b) => {
      const idx = b.watch.groups.findIndex((g) => g.name === group.name);
      if (idx < 0) {
        return { ...b, watch: { ...b.watch, groups: [...b.watch.groups, group] } };
      }
      if (!allowReplace) {
        throw new Error(`group ${group.name} already exists`);
      }
      const next = [...b.watch.groups];
      next[idx] = group;
      return { ...b, watch: { ...b.watch, groups: next } };
    });
  }

  async patch(
    userId: string,
    name: string,
    apply: (current: WatchGroup) => WatchGroup,
  ): Promise<WatchGroup | undefined> {
    let updated: WatchGroup | undefined;
    await this.blob.update(userId, (b) => {
      const idx = b.watch.groups.findIndex((g) => g.name === name);
      if (idx < 0) return b;
      const cur = b.watch.groups[idx];
      if (cur === undefined) return b;
      updated = apply(cur);
      const next = [...b.watch.groups];
      next[idx] = updated;
      return { ...b, watch: { ...b.watch, groups: next } };
    });
    return updated;
  }

  async delete(userId: string, name: string): Promise<boolean> {
    let removed = false;
    await this.blob.update(userId, (b) => {
      const next = b.watch.groups.filter((g) => g.name !== name);
      removed = next.length !== b.watch.groups.length;
      if (!removed) return b;
      return { ...b, watch: { ...b.watch, groups: next } };
    });
    return removed;
  }
}
