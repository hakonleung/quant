/**
 * Pure batch-matcher for the M-0 search box.
 *
 * Users can paste a JSON `string[]` instead of typing one symbol at a
 * time. Each entry is dispatched to a market by shape, then matched
 * against the universe under that market only:
 *
 *   - all-letter token → US: `meta.code.split('.')[1] === entry`
 *     (akshare US codes look like `"105.AAPL"`; the suffix is the bare
 *     ticker the user typed.)
 *   - all-digits with length < 6, or `hk`-prefixed digits → HK:
 *     `+entry.replace(/^hk/i, '') === +meta.code` (numeric compare so
 *     `00700`, `0700`, `700` all match the same instrument).
 *   - everything else → A-share: `meta.code === entry`.
 *
 * The function never throws on parse failure — `kind: 'invalid'`
 * carries a human-readable reason. Returning a discriminated union
 * keeps the caller's branching exhaustive.
 */

import type { UniverseStock } from '../hooks/use-stock-universe.js';

export type BatchMatchResult =
  | { readonly kind: 'invalid'; readonly reason: string }
  | {
      readonly kind: 'matched';
      readonly items: readonly UniverseStock[];
    }
  | {
      readonly kind: 'partial';
      readonly matched: readonly UniverseStock[];
      readonly unmatched: readonly string[];
    };

export type BatchTarget = 'a' | 'hk' | 'us';

export function classifyEntry(entry: string): BatchTarget {
  const s = entry.trim();
  if (/^[a-zA-Z]+$/.test(s)) return 'us';
  if (/^hk\d+$/i.test(s)) return 'hk';
  if (/^\d+$/.test(s) && s.length < 6) return 'hk';
  return 'a';
}

/**
 * Try to interpret `text` as a JSON `string[]`. Returns `null` when the
 * payload isn't valid JSON or doesn't decode to an array of strings —
 * the caller treats this as "not in batch mode".
 */
export function tryParseBatchInput(text: string): readonly string[] | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('[')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: string[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string') return null;
    const v = item.trim();
    if (v === '') continue;
    out.push(v);
  }
  return out;
}

interface UniverseIndex {
  readonly a: ReadonlyMap<string, UniverseStock>;
  readonly hk: ReadonlyMap<number, UniverseStock>;
  readonly us: ReadonlyMap<string, UniverseStock>;
}

function buildIndex(rows: readonly UniverseStock[]): UniverseIndex {
  const a = new Map<string, UniverseStock>();
  const hk = new Map<number, UniverseStock>();
  const us = new Map<string, UniverseStock>();
  for (const r of rows) {
    if (r.market === 'a') {
      a.set(r.code, r);
    } else if (r.market === 'hk') {
      const n = Number(r.code);
      if (Number.isFinite(n)) hk.set(n, r);
    } else {
      const parts = r.code.split('.');
      const sym = parts.length === 2 ? parts[1] : r.code;
      if (sym !== undefined && sym !== '') us.set(sym.toUpperCase(), r);
    }
  }
  return { a, hk, us };
}

export function matchBatch(
  entries: readonly string[],
  universe: readonly UniverseStock[],
): BatchMatchResult {
  if (entries.length === 0) {
    return { kind: 'invalid', reason: 'empty input' };
  }
  const idx = buildIndex(universe);
  const matched: UniverseStock[] = [];
  const unmatched: string[] = [];
  const seen = new Set<string>();
  for (const raw of entries) {
    const entry = raw.trim();
    if (entry === '') continue;
    const target = classifyEntry(entry);
    let hit: UniverseStock | undefined;
    if (target === 'us') {
      hit = idx.us.get(entry.toUpperCase());
    } else if (target === 'hk') {
      const n = Number(entry.replace(/^hk/i, ''));
      hit = Number.isFinite(n) ? idx.hk.get(n) : undefined;
    } else {
      hit = idx.a.get(entry);
    }
    if (hit === undefined) {
      unmatched.push(entry);
    } else {
      const key = `${hit.market}:${hit.code}`;
      if (!seen.has(key)) {
        seen.add(key);
        matched.push(hit);
      }
    }
  }
  if (unmatched.length > 0) {
    return { kind: 'partial', matched, unmatched };
  }
  return { kind: 'matched', items: matched };
}
