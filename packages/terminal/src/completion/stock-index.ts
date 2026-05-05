/**
 * In-memory three-way prefix index over the stock universe.
 *
 * Pure / no IO (CLAUDE.md §2.5.1). The terminal Feat populates the index
 * from the action runner once on mount; commands read the singleton via
 * `CommandCtx.stockIndex`.
 */

import type { StockMeta } from '../actions/registry.js';

export interface StockMatch {
  readonly code: string;
  readonly name: string;
  readonly label: string;
}

export interface StockIndex {
  readonly size: number;
  /** Returns up to `limit` matches ranked by source (code > name > pinyin). */
  complete(prefix: string, limit?: number): readonly StockMatch[];
  /** Strict equality lookup. */
  byCode(code: string): StockMeta | null;
  /** All entries — used by widgets that need the full universe (pickStockLoop). */
  all(): readonly StockMeta[];
}

export function buildStockIndex(metas: readonly StockMeta[]): StockIndex {
  const codes = [...metas].sort((a, b) => a.code.localeCompare(b.code));
  const byCode = new Map<string, StockMeta>(codes.map((m) => [m.code, m]));
  const byName: { name: string; meta: StockMeta }[] = codes
    .map((m) => ({ name: m.name.toLowerCase(), meta: m }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const byPinyin: { pinyin: string; meta: StockMeta }[] = codes
    .filter((m) => m.pinyin !== undefined && m.pinyin.length > 0)
    .map((m) => ({ pinyin: (m.pinyin ?? '').toLowerCase(), meta: m }))
    .sort((a, b) => a.pinyin.localeCompare(b.pinyin));

  return {
    size: codes.length,

    byCode(code: string): StockMeta | null {
      return byCode.get(code) ?? null;
    },

    all(): readonly StockMeta[] {
      return codes;
    },

    complete(prefixIn: string, limitIn?: number): readonly StockMatch[] {
      const prefix = prefixIn.trim().toLowerCase();
      const limit = limitIn ?? 20;
      if (prefix.length === 0) return [];
      const seen = new Set<string>();
      const matches: StockMatch[] = [];

      const push = (m: StockMeta, label: string): void => {
        if (seen.has(m.code) || matches.length >= limit) return;
        seen.add(m.code);
        matches.push({ code: m.code, name: m.name, label });
      };

      // 1) by code prefix (digit-only) or substring
      if (/^\d+$/u.test(prefix)) {
        for (const m of codes) {
          if (m.code.startsWith(prefix)) push(m, `${m.code} ${m.name}`);
          if (matches.length >= limit) return matches;
        }
      }

      // 2) by name substring
      for (const { meta } of byName) {
        if (meta.name.toLowerCase().includes(prefix)) {
          push(meta, `${meta.code} ${meta.name}`);
          if (matches.length >= limit) return matches;
        }
      }

      // 3) by pinyin prefix
      for (const { pinyin, meta } of byPinyin) {
        if (pinyin.startsWith(prefix)) {
          push(meta, `${meta.code} ${meta.name}`);
          if (matches.length >= limit) return matches;
        }
      }

      return matches;
    },
  };
}

/** Empty placeholder used before the first stock.list resolves. */
export const EMPTY_STOCK_INDEX: StockIndex = buildStockIndex([]);
