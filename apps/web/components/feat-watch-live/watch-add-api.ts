'use client';

/**
 * Network adapter for the WATCH add-form. Pulls all the `fetch` calls
 * out of `watch-add-form.tsx` so the form component stays under the
 * 400-line ceiling and so the wire shapes are tested in one place
 * (CLAUDE.md §1.3 — system boundary code lives in adapters).
 */

import { WatchGroupCreateSchema, WatchGroupSchema, type WatchGroup } from '@quant/shared';
import { z } from 'zod';

import {
  buildDraft,
  minuteStringToSeconds,
  toCondition,
  type AddFormState,
  type PickedStock,
} from '../../lib/fp/watch-add-fp.js';

export async function fetchGroups(): Promise<readonly WatchGroup[]> {
  // No `cache: 'no-store'` — react-query owns staleness; bypassing the
  // HTTP cache here just slowed every USR-pane mount with a needless
  // round-trip.
  const res = await fetch('/api/watch/groups');
  if (!res.ok) throw new Error(`groups list failed: ${String(res.status)}`);
  const raw: unknown = await res.json();
  return z.array(WatchGroupSchema).parse(raw);
}

export async function postGroup(state: AddFormState, name: string): Promise<WatchGroup> {
  const body = WatchGroupCreateSchema.parse({
    name,
    conditions: state.conditions.map(toCondition),
    intervalSec: minuteStringToSeconds(state.intervalMin),
    pushIntervalSec: minuteStringToSeconds(state.pushIntervalMin),
  });
  const res = await fetch('/api/watch/groups', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`group create failed: ${String(res.status)} ${text.slice(0, 100)}`);
  }
  return WatchGroupSchema.parse(await res.json());
}

async function postOne(stock: PickedStock, groupName: string): Promise<string | null> {
  const draft = buildDraft(stock, groupName);
  const res = await fetch('/api/watch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(draft),
  });
  if (res.ok) return null;
  const body = await res.text();
  return `[${stock.market}] ${stock.code} → ${String(res.status)} ${body.slice(0, 100)}`;
}

/**
 * Submit one task per picked stock. Returns the list of human-readable
 * failure messages — empty on full success. v0 deliberately serial:
 * the BFF doesn't expose a batch endpoint and the picked-stock count
 * is small enough (typically < 20) that parallel POSTs aren't worth
 * the error-handling complexity.
 */
export async function postBatch(
  picked: readonly PickedStock[],
  groupName: string,
): Promise<readonly string[]> {
  const errs: string[] = [];
  for (const stock of picked) {
    try {
      const failure = await postOne(stock, groupName);
      if (failure !== null) errs.push(failure);
    } catch (e) {
      errs.push(`[${stock.market}] ${stock.code}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return errs;
}
