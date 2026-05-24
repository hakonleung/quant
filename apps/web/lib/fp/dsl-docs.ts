/**
 * Tooltip text for every operator / function the DSL exposes
 * (modules/03-screening.md §3 — closed vocabulary). Lives in `lib/fp/`
 * because it's pure data (no IO, no DOM) — usable from server- and
 * client-side renderers.
 *
 * Keep entries in sync with the Python AST nodes in
 * `services/py/quant_core/domain/types/screen.py` and
 * `universe_screen.py`. A missing key resolves to a fall-back
 * description (`unknownDoc(key)`) so a freshly-added op never hard-
 * crashes the renderer.
 */

export interface DslDoc {
  readonly title: string;
  readonly description: string;
  readonly example?: string;
}

const COMPARE_OPS: Readonly<Record<string, DslDoc>> = {
  gt: { title: '>', description: '左值严格大于右值。', example: 'close > 100' },
  gte: { title: '≥', description: '左值大于或等于右值。', example: 'volume ≥ 1e6' },
  lt: { title: '<', description: '左值严格小于右值。', example: 'rsi14 < 25' },
  lte: { title: '≤', description: '左值小于或等于右值。', example: 'pe ≤ 15' },
  eq: { title: '==', description: '左值等于右值。' },
  neq: { title: '≠', description: '左值不等于右值。' },
  contains: { title: 'contains', description: '左侧字段包含右值（仅 universe）。' },
  starts_with: { title: 'starts_with', description: '左侧字段以右值开头。' },
  not_starts_with: { title: '!starts_with', description: '左侧字段不以右值开头。' },
};

const LOGICAL_OPS: Readonly<Record<string, DslDoc>> = {
  and: { title: 'AND', description: '所有子条件都成立。' },
  or: { title: 'OR', description: '任一子条件成立。' },
  not: { title: 'NOT', description: '取反。' },
};

const STRUCTURAL_OPS: Readonly<Record<string, DslDoc>> = {
  for_all: {
    title: 'for_all(window)',
    description: '在指定回看窗口内每一个交易日上，子谓词都成立。',
    example: 'for_all(20d): close > ma20',
  },
  exists: {
    title: 'exists(window)',
    description: '在窗口内至少一个交易日上，子谓词成立。',
    example: 'exists(60d): close = ma60',
  },
  consecutive: {
    title: 'consecutive(min_len)',
    description: '子谓词连续 min_len 个交易日成立。',
    example: 'consecutive(3): pct_chg > 0',
  },
};

const AGG_FUNCTIONS: Readonly<Record<string, DslDoc>> = {
  max: { title: 'max(field, window)', description: '窗口内字段最大值。' },
  min: { title: 'min(field, window)', description: '窗口内字段最小值。' },
  avg: { title: 'avg(field, window)', description: '窗口内字段算术平均。' },
  mean: { title: 'mean(field, window)', description: '同 avg：窗口内算术平均。' },
  sum: { title: 'sum(field, window)', description: '窗口内字段求和。' },
  std: { title: 'std(field, window)', description: '窗口内样本标准差。' },
  std_dev: { title: 'std_dev(field, window)', description: '同 std：样本标准差。' },
  zscore: {
    title: 'zscore(field, window)',
    description: '当前值 - 窗口均值，除以窗口标准差。',
  },
};

const FIELD_DOCS: Readonly<Record<string, DslDoc>> = {
  open: { title: 'open', description: '当日开盘价（前复权）。' },
  high: { title: 'high', description: '当日最高价（前复权）。' },
  low: { title: 'low', description: '当日最低价（前复权）。' },
  close: { title: 'close', description: '当日收盘价（前复权）。' },
  volume: { title: 'volume', description: '当日成交量（股）。' },
  amount: { title: 'amount', description: '当日成交额（元）。' },
  turnover_rate: { title: 'turnover_rate', description: '当日换手率（小数）。' },
  ma5: { title: 'MA5', description: '5 日均线（基于前复权 close）。' },
  ma10: { title: 'MA10', description: '10 日均线。' },
  ma20: { title: 'MA20', description: '20 日均线。' },
  ma60: { title: 'MA60', description: '60 日均线。' },
  rsi14: { title: 'RSI14', description: '14 日相对强弱指标。' },
  pct_chg: { title: 'pct_chg', description: '当日涨跌幅。' },
  pct_chg_qfq: { title: 'pct_chg_qfq', description: '当日前复权涨跌幅。' },
  industry: { title: 'industry', description: '所属行业（universe 维度）。' },
  market: { title: 'market', description: '上市市场代码（SH/SZ/BJ）。' },
  list_date: { title: 'list_date', description: '上市日期。' },
  pe: { title: 'pe', description: '市盈率（TTM）。' },
  pb: { title: 'pb', description: '市净率。' },
  // ---- WCMI 90-day wave-quality (universe.derived)
  wcmi: { title: 'WCMI', description: '90 日波形质量综合分 [0, 1000]，越高越好。' },
  wcmi_rhythm: { title: 'WCMI 节奏', description: '走势节奏子项的横截面百分位 × 100。' },
  wcmi_ma_support: {
    title: 'WCMI 均线支撑',
    description: '均线支撑/粘合度的横截面百分位 × 100。',
  },
  wcmi_up_wave: {
    title: 'WCMI 上升浪',
    description: '上升浪推升力度的横截面百分位 × 100。',
  },
  wcmi_yang_dom: {
    title: 'WCMI 阳线占优',
    description: '阳线占优/多头主导的横截面百分位 × 100。',
  },
  wcmi_shadow_clean: {
    title: 'WCMI 上影线干净',
    description: '上影线干净度的横截面百分位 × 100。',
  },
  wcmi_stage_gain: {
    title: 'WCMI 阶段涨幅',
    description: '阶段涨幅子项的横截面百分位 × 100。',
  },
  wcmi_crash_avoid: { title: 'WCMI 抗跌', description: '回撤防御能力的横截面百分位 × 100。' },
  wcmi_recent_strength: {
    title: 'WCMI 近端强势',
    description: '近端强度子项的横截面百分位 × 100。',
  },
};

const STRUCT_DOCS: Readonly<Record<string, DslDoc>> = {
  field: { title: 'field', description: '取当日某个 K 线字段。' },
  const: { title: 'const', description: '常量字面量。' },
  agg: { title: 'agg', description: '在窗口上聚合一个字段。' },
  period_return: {
    title: 'period_return',
    description: '指定窗口的累计收益率（基于前复权 close）。',
  },
  scale: {
    title: 'scale',
    description: '将左侧标量乘以一个常量因子（用于 "X 高于 Y 的 K%" 这类比例条件）。',
    example: 'scale(max(high_qfq, 60d), 0.9)',
  },
};

export function describeCompareOp(op: string): DslDoc {
  return COMPARE_OPS[op] ?? unknownDoc(`compare.${op}`);
}

export function describeLogicalOp(op: string): DslDoc {
  return LOGICAL_OPS[op] ?? unknownDoc(`logical.${op}`);
}

export function describeStructural(kind: 'for_all' | 'exists' | 'consecutive'): DslDoc {
  return STRUCTURAL_OPS[kind] ?? unknownDoc(`structural.${kind}`);
}

export function describeAggregate(fn: string): DslDoc {
  return AGG_FUNCTIONS[fn] ?? unknownDoc(`agg.${fn}`);
}

export function describeField(field: string): DslDoc {
  return FIELD_DOCS[field] ?? unknownDoc(`field.${field}`);
}

export function describeNodeKind(kind: string): DslDoc {
  return STRUCT_DOCS[kind] ?? unknownDoc(`kind.${kind}`);
}

function unknownDoc(key: string): DslDoc {
  return {
    title: key,
    description: '尚未在前端文档表登记 — 请提交 PR 完善 dsl-docs.ts。',
  };
}
