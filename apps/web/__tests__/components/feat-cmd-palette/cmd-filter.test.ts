import { describe, expect, it } from 'vitest';

import {
  filterCmdItems,
  type CmdItem,
} from '../../../components/feat-cmd-palette/cmd-filter.js';

const NOOP = (): void => undefined;

const item = (
  id: string,
  category: CmdItem['category'],
  title: string,
  subtitle?: string,
): CmdItem => {
  if (subtitle === undefined) {
    return { id, category, title, run: NOOP };
  }
  return { id, category, title, subtitle, run: NOOP };
};

describe('filterCmdItems', () => {
  describe('empty query', () => {
    it('preserves natural order across categories', () => {
      const items = [
        item('m1', 'mode', '终端模式'),
        item('s1', 'stock', '600519 贵州茅台'),
        item('l1', 'layout', '布局 · 默认'),
      ];
      const out = filterCmdItems(items, '', 30);
      expect(out.map((i) => i.id)).toEqual(['m1', 's1', 'l1']);
    });

    it('caps stocks at maxStocks but keeps every non-stock', () => {
      const items: CmdItem[] = [
        item('m1', 'mode', 'mode-1'),
        item('l1', 'layout', 'layout-1'),
        ...Array.from({ length: 50 }, (_, i) => item(`stk-${String(i)}`, 'stock', `stock ${String(i)}`)),
      ];
      const out = filterCmdItems(items, '', 5);
      expect(out.filter((i) => i.category === 'stock')).toHaveLength(5);
      expect(out.filter((i) => i.category === 'mode')).toHaveLength(1);
      expect(out.filter((i) => i.category === 'layout')).toHaveLength(1);
    });

    it('drops nothing when stock count is under the cap', () => {
      const items = [
        item('s1', 'stock', '600519'),
        item('s2', 'stock', '300750'),
      ];
      expect(filterCmdItems(items, '', 30)).toEqual(items);
    });
  });

  describe('matching', () => {
    it('returns only items whose title or subtitle contains the needle', () => {
      const items = [
        item('s1', 'stock', '600519 贵州茅台'),
        item('s2', 'stock', '300750 宁德时代'),
        item('s3', 'stock', '000001 平安银行'),
      ];
      const out = filterCmdItems(items, '茅台', 30);
      expect(out.map((i) => i.id)).toEqual(['s1']);
    });

    it('is case-insensitive', () => {
      const items = [item('m1', 'mode', 'TERMINAL mode')];
      expect(filterCmdItems(items, 'terminal', 30)).toHaveLength(1);
    });

    it('matches against subtitle as well', () => {
      const items = [
        item('s1', 'sector', '科技', '动态板块 · 5 codes'),
        item('s2', 'sector', '医药', 'user · 12 codes'),
      ];
      const out = filterCmdItems(items, '动态', 30);
      expect(out.map((i) => i.id)).toEqual(['s1']);
    });

    it('drops everything when nothing matches', () => {
      const items = [item('s1', 'stock', '600519')];
      expect(filterCmdItems(items, 'zzz', 30)).toEqual([]);
    });
  });

  describe('ranking', () => {
    it('matches at the start of the title outrank later matches', () => {
      const items = [
        item('a', 'stock', '300519 something'),
        item('b', 'stock', '600519 vinegar'),
      ];
      // "519" appears at idx 1 in 'a' and idx 1 in 'b'.
      // category bias breaks the tie but keeps the natural input order.
      const earlier = item('c', 'stock', '519 leading');
      const out = filterCmdItems([...items, earlier], '519', 30);
      expect(out[0]?.id).toBe('c');
    });

    it('sorts categories in canonical order regardless of relevance', () => {
      const items = [
        item('s1', 'stock', '茅台 600519'),
        item('m1', 'mode', '茅台 quick mode'),
        item('l1', 'layout', '茅台 layout'),
        item('sec1', 'sector', '茅台 sector'),
      ];
      const out = filterCmdItems(items, '茅台', 30);
      // mode → layout → sector → stock
      expect(out.map((i) => i.category)).toEqual(['mode', 'layout', 'sector', 'stock']);
    });

    it('preserves relevance order within a category (stable sort)', () => {
      const items = [
        item('late', 'stock', 'xx 300519'),     // 'tg' not present here, change needle
        item('early', 'stock', '300519 tg'),
        item('mid', 'stock', '300tg519'),
      ];
      const out = filterCmdItems(items, 'tg', 30);
      // Substring index of 'tg':
      //   'xx 300519'      → -1 (filtered out)
      //   '300519 tg'      → 7
      //   '300tg519'       → 3
      // After bucketing all are stock, so order is the score order.
      expect(out.map((i) => i.id)).toEqual(['mid', 'early']);
    });

    it('caps stocks even after ranking — non-stocks survive', () => {
      const stocks: CmdItem[] = Array.from({ length: 10 }, (_, i) =>
        item(`s-${String(i)}`, 'stock', `match-${String(i)}`),
      );
      const items: CmdItem[] = [
        item('m1', 'mode', 'match mode'),
        item('l1', 'layout', 'match layout'),
        ...stocks,
      ];
      const out = filterCmdItems(items, 'match', 3);
      expect(out.filter((i) => i.category === 'stock')).toHaveLength(3);
      expect(out.find((i) => i.category === 'mode')?.id).toBe('m1');
      expect(out.find((i) => i.category === 'layout')?.id).toBe('l1');
    });
  });
});
