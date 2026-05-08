/**
 * Pure filter / ranking for the command-palette result list.
 * Lifted out of the React component so it can be unit-tested without
 * jsdom (CLAUDE.md §2.5.1).
 */

export type CmdCategory = 'stock' | 'sector' | 'layout' | 'mode';

export interface CmdItem {
  readonly id: string;
  readonly category: CmdCategory;
  readonly title: string;
  readonly subtitle?: string;
  readonly run: () => void;
}

const CATEGORY_RANK: Record<CmdCategory, number> = {
  mode: 0,
  layout: 1,
  sector: 2,
  stock: 3,
};

const CATEGORY_BIAS: Record<CmdCategory, number> = {
  mode: 0,
  layout: 1,
  sector: 2,
  stock: 3,
};

/**
 * Filter + sort + cap the command list. Pure — no DOM, no state.
 *
 * Empty query keeps the natural order (mode → layout → sector →
 * stock); stocks beyond `maxStocks` are dropped so the 5 500-row
 * universe doesn't render.
 *
 * Non-empty query scores by case-insensitive substring index across
 * `title + subtitle`; lower index wins. After the score sort, items
 * are bucketed by category (stable sort preserves the within-bucket
 * relevance order) so headers print in the canonical sequence.
 */
export function filterCmdItems(
  items: readonly CmdItem[],
  query: string,
  maxStocks: number,
): readonly CmdItem[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return capStocks(items, maxStocks);

  const scored: { readonly item: CmdItem; readonly score: number }[] = [];
  for (const item of items) {
    const hay = `${item.title} ${item.subtitle ?? ''}`.toLowerCase();
    const idx = hay.indexOf(q);
    if (idx === -1) continue;
    scored.push({ item, score: idx * 10 + CATEGORY_BIAS[item.category] });
  }
  scored.sort((a, b) => a.score - b.score);
  const inOrder: CmdItem[] = scored.map((s) => s.item);
  inOrder.sort((a, b) => CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category]);
  return capStocks(inOrder, maxStocks);
}

function capStocks(items: readonly CmdItem[], maxStocks: number): readonly CmdItem[] {
  let stockCount = 0;
  const out: CmdItem[] = [];
  for (const it of items) {
    if (it.category === 'stock') {
      if (stockCount >= maxStocks) continue;
      stockCount += 1;
    }
    out.push(it);
  }
  return out;
}
