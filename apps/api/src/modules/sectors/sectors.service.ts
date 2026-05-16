/**
 * Sector business logic + ownership gating. Controllers and instruction
 * handlers should not talk to `SectorsStore` directly — `requireOwner`
 * lives here so every write path goes through the same check.
 */

import { Inject, Injectable } from '@nestjs/common';
import { QuantError, type Sector } from '@quant/shared';

import { CLOCK, type Clock } from '../../common/clock.js';
import { ScreenExecService } from '../screen/screen-exec.service.js';
import { SectorsStore } from './sectors.store.js';

@Injectable()
export class SectorsService {
  constructor(
    @Inject(SectorsStore) private readonly store: SectorsStore,
    @Inject(ScreenExecService) private readonly screenExec: ScreenExecService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  listVisibleTo(userId: string): readonly Sector[] {
    return this.store.listVisibleTo(userId);
  }

  listOwnedBy(userId: string): readonly Sector[] {
    return this.store.listOwnedBy(userId);
  }

  /**
   * Replace only the caller's own sectors. Sectors owned by others (and
   * `published` records owned by others) pass through untouched. Throws
   * `FORBIDDEN` when the body claims to mutate someone else's record.
   */
  async replaceForUser(userId: string, incoming: readonly Sector[]): Promise<readonly Sector[]> {
    const stamped = incoming.map((s) => ({ ...s, createdBy: userId }));
    return this.store.replaceForUser(userId, stamped);
  }

  async upsert(userId: string, sector: Sector): Promise<Sector> {
    const existing = this.store.findById(sector.id);
    if (existing && existing.createdBy !== userId) {
      throw new QuantError('FORBIDDEN', `cannot edit sector ${sector.id}: not owner`, {
        id: sector.id,
        owner: existing.createdBy,
      });
    }
    const merged: Sector = {
      ...sector,
      createdBy: userId,
      published: existing?.published ?? sector.published,
      ...(existing?.publishedAt !== undefined ? { publishedAt: existing.publishedAt } : {}),
    };
    return this.store.upsert(merged);
  }

  async remove(userId: string, id: string): Promise<void> {
    this.requireOwner(id, userId);
    const ok = await this.store.removeById(id);
    if (!ok) {
      throw new QuantError('NOT_FOUND', `sector ${id} not found`, { id });
    }
  }

  /** Publish / unpublish a sector — owner only. Idempotent. */
  async setPublished(userId: string, id: string, published: boolean): Promise<Sector> {
    const current = this.requireOwner(id, userId);
    const publishedAt = published ? this.clock.now().toISOString() : undefined;
    const next: Sector = {
      ...current,
      published,
      ...(publishedAt !== undefined ? { publishedAt } : {}),
    };
    if (!published) {
      // strip publishedAt by writing a clone without that key
      const { publishedAt: _omit, ...rest } = next;
      void _omit;
      return this.store.upsert(rest);
    }
    return this.store.upsert(next);
  }

  /**
   * Refresh a dynamic sector by re-running its `screenPlan`. Any user
   * (owner or not) may trigger; codes/lastScreenedAt persist for everyone.
   */
  async refreshDynamic(_userId: string, id: string, traceId: string): Promise<Sector> {
    const current = this.store.findById(id);
    if (current === null) {
      throw new QuantError('NOT_FOUND', `sector ${id} not found`, { id });
    }
    if (current.kind !== 'dynamic') {
      throw new QuantError('INVALID_ARGUMENT', `sector ${id} is not dynamic`, {
        id,
        kind: current.kind,
      });
    }
    if (current.screenPlan === undefined) {
      throw new QuantError('INVALID_ARGUMENT', `sector ${id} has no screenPlan to re-run`, { id });
    }
    // Override asof to today so refresh always evaluates against the
    // freshest kline data. The asof saved on the plan reflects the
    // creation point; without this override every refresh would re-pin
    // to that snapshot and ignore subsequent updates.
    const todayIso = this.clock.now().toISOString().slice(0, 10);
    const screenPlan = { ...current.screenPlan, asof: todayIso };
    const universePlan =
      current.universePlan !== undefined && current.universePlan !== null
        ? { ...current.universePlan, asof: todayIso }
        : null;
    const rank = current.rank ?? null;
    void traceId;
    const result = await this.screenExec.execute(screenPlan, universePlan, rank);
    const codes = result.matches.map((m) => m.code);
    const evidence: Record<string, Record<string, unknown>> = {};
    for (const m of result.matches) evidence[m.code] = m.evidence;
    const refreshed: Sector = {
      ...current,
      codes,
      count: codes.length,
      evidence,
      lastScreenedAt: this.clock.now().toISOString(),
    };
    return this.store.upsert(refreshed);
  }

  /**
   * Resolve a sector by `id` or `name`, scoped to what `userId` may see
   * (own + published). Throws `NOT_FOUND` when invisible.
   */
  resolveVisible(userId: string, idOrName: string): Sector {
    const visible = this.store.listVisibleTo(userId);
    const lower = idOrName.toLowerCase();
    const match =
      visible.find((s) => s.id === idOrName) ??
      visible.find((s) => s.name === idOrName) ??
      visible.find((s) => s.id.toLowerCase() === lower || s.name.toLowerCase() === lower) ??
      null;
    if (match === null) {
      throw new QuantError('NOT_FOUND', `sector ${idOrName} not found`, { idOrName });
    }
    return match;
  }

  private requireOwner(id: string, userId: string): Sector {
    const current = this.store.findById(id);
    if (current === null) {
      throw new QuantError('NOT_FOUND', `sector ${id} not found`, { id });
    }
    if (current.createdBy !== userId) {
      throw new QuantError('FORBIDDEN', `sector ${id} owned by ${current.createdBy}`, {
        id,
        owner: current.createdBy,
      });
    }
    return current;
  }
}
