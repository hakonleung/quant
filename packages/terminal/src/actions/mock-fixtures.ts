/**
 * Static fixture data for the mock action runner. Generated programmatically
 * to keep file size sane while still providing realistic distribution.
 *
 * NOTE: code numbers, names, and industries are intentionally synthetic — do
 * NOT trust their values for any real-world reasoning.
 */

import type {
  KlineBar,
  MarketSentiment,
  Sector,
  Sentiment,
  StockMeta,
  StockSnapshot,
  WatchTask,
} from './registry.js';

const REAL_SAMPLE: ReadonlyArray<{ code: string; name: string; pinyin: string; industry: string }> = [
  { code: '600519', name: '贵州茅台', pinyin: 'gzmt', industry: '白酒' },
  { code: '000858', name: '五粮液', pinyin: 'wly', industry: '白酒' },
  { code: '000568', name: '泸州老窖', pinyin: 'lzlj', industry: '白酒' },
  { code: '600809', name: '山西汾酒', pinyin: 'sxfj', industry: '白酒' },
  { code: '600036', name: '招商银行', pinyin: 'zsyh', industry: '银行' },
  { code: '000001', name: '平安银行', pinyin: 'payh', industry: '银行' },
  { code: '601398', name: '工商银行', pinyin: 'gsyh', industry: '银行' },
  { code: '600000', name: '浦发银行', pinyin: 'pfyh', industry: '银行' },
  { code: '601318', name: '中国平安', pinyin: 'zgpa', industry: '保险' },
  { code: '601628', name: '中国人寿', pinyin: 'zgrs', industry: '保险' },
  { code: '300750', name: '宁德时代', pinyin: 'ndsd', industry: '电池' },
  { code: '002594', name: '比亚迪', pinyin: 'byd', industry: '汽车' },
  { code: '600276', name: '恒瑞医药', pinyin: 'hryy', industry: '医药' },
  { code: '300760', name: '迈瑞医疗', pinyin: 'mryl', industry: '医药' },
  { code: '601012', name: '隆基绿能', pinyin: 'ljln', industry: '光伏' },
  { code: '600900', name: '长江电力', pinyin: 'cjdl', industry: '电力' },
];

function generateMetas(): readonly StockMeta[] {
  const out: StockMeta[] = [...REAL_SAMPLE.map((s) => ({ ...s, market: 'a' as const }))];
  const industries = ['计算机', '电子', '机械', '化工', '钢铁', '通信', '传媒', '建材'];
  // Pad to ~200 with synthetic codes
  for (let i = 0; i < 184; i += 1) {
    const num = 300000 + i;
    const code = String(num).padStart(6, '0');
    const ind = industries[i % industries.length] as string;
    out.push({
      code,
      name: `测试${String(i + 1)}`,
      pinyin: `cs${String(i + 1)}`,
      industry: ind,
      market: 'a',
    });
  }
  return out;
}

const _stockMetas = generateMetas();

export function fixtureStockMetas(): readonly StockMeta[] {
  return _stockMetas;
}

export function fixtureStockMeta(code: string): StockMeta | null {
  return _stockMetas.find((m) => m.code === code) ?? null;
}

export function fixtureKline(code: string, range: '30D' | '90D' | '250D'): readonly KlineBar[] {
  const days = range === '30D' ? 30 : range === '90D' ? 90 : 250;
  const out: KlineBar[] = [];
  // Deterministic pseudo-random seeded by code
  let seed = Number.parseInt(code, 10) % 997;
  const rand = (): number => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  let close = 50 + (Number.parseInt(code, 10) % 50);
  const today = Date.now();
  for (let i = days - 1; i >= 0; i -= 1) {
    const drift = (rand() - 0.5) * 2;
    const open = close;
    close = Math.max(1, open + drift);
    const high = Math.max(open, close) + rand() * 0.5;
    const low = Math.min(open, close) - rand() * 0.5;
    const date = new Date(today - i * 86_400_000).toISOString().slice(0, 10);
    out.push({
      date,
      open: round(open),
      high: round(high),
      low: round(low),
      close: round(close),
      volume: Math.round(rand() * 1_000_000),
    });
  }
  return out;
}

export function fixtureSnapshots(codes: readonly string[]): readonly StockSnapshot[] {
  const today = new Date().toISOString().slice(0, 10);
  const out: StockSnapshot[] = [];
  for (const code of codes) {
    const meta = fixtureStockMeta(code);
    if (meta === null) continue;
    const last = fixtureKline(code, '30D').at(-1);
    out.push({
      code,
      price: last?.close ?? null,
      asof: today,
      pe_ttm: round(15 + (Number.parseInt(code, 10) % 25)),
      pb: round(2 + (Number.parseInt(code, 10) % 5) * 0.3),
      mkt_cap: Math.round((last?.close ?? 1) * 1_000_000_000),
    });
  }
  return out;
}

export function fixtureSentiment(code: string): Sentiment {
  const score = ((Number.parseInt(code, 10) % 200) - 100) / 100;
  return {
    code,
    score: round(score),
    theme: '行业景气复苏',
    driver: '需求边际改善',
    cachedAt: new Date().toISOString(),
  };
}

export function fixtureMarketSentiment(codes: readonly string[]): MarketSentiment {
  const total = codes.reduce(
    (acc, c) => acc + (((Number.parseInt(c, 10) % 200) - 100) / 100),
    0,
  );
  const avg = codes.length === 0 ? 0 : total / codes.length;
  return {
    codes: [...codes],
    score: round(avg),
    themes: ['行业景气复苏', '资金流入'],
    cachedAt: new Date().toISOString(),
  };
}

export function fixtureScreenResult(nl: string): {
  nl: string;
  matches: { code: string; name: string; score: number | null }[];
  dslSummary: string;
} {
  const matches = _stockMetas.slice(0, 8).map((m, i) => ({
    code: m.code,
    name: m.name,
    score: round(0.9 - i * 0.08),
  }));
  return {
    nl,
    matches,
    dslSummary: `mock(${nl}) → close > 0 AND ma60 > 0`,
  };
}

/* ---------- in-memory mutable state for sectors / watch ---------- */

const _sectors: Sector[] = [];
const _watch: WatchTask[] = [];

export function fixtureSectors(): readonly Sector[] {
  return _sectors;
}

export function fixtureUpsertSector(sector: Sector): Sector {
  const idx = _sectors.findIndex((s) => s.id === sector.id || s.name === sector.name);
  if (idx >= 0) {
    _sectors[idx] = sector;
  } else {
    _sectors.push(sector);
  }
  return sector;
}

export function fixtureRemoveSector(idOrName: string): boolean {
  const idx = _sectors.findIndex((s) => s.id === idOrName || s.name === idOrName);
  if (idx < 0) return false;
  _sectors.splice(idx, 1);
  return true;
}

export function fixtureFindSector(idOrName: string): Sector | null {
  return _sectors.find((s) => s.id === idOrName || s.name === idOrName) ?? null;
}

export function fixtureWatch(): readonly WatchTask[] {
  return _watch;
}

export function fixtureUpsertWatch(task: WatchTask): WatchTask {
  const idx = _watch.findIndex((t) => t.market === task.market && t.code === task.code);
  if (idx >= 0) {
    _watch[idx] = task;
  } else {
    _watch.push(task);
  }
  return task;
}

export function fixtureRemoveWatch(market: string, code: string): boolean {
  const idx = _watch.findIndex((t) => t.market === market && t.code === code);
  if (idx < 0) return false;
  _watch.splice(idx, 1);
  return true;
}

/** Reset everything — used by tests. */
export function _resetFixtures(): void {
  _sectors.splice(0);
  _watch.splice(0);
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
