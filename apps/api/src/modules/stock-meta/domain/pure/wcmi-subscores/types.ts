/**
 * WCMI v2（90 日波动质量）评分引擎的类型定义。
 * 设计文档：`docs/perf/wcmi-redesign.md`；
 * 默认参数来自 `apps/api/scripts/wcmi-backtest.ts` 的多轮回测收敛结果，
 * 调参逐轮日志：`docs/perf/wcmi-redesign-backtest.md`。
 *
 * 所有可调常量统一收敛到 `WCMI_CONFIG`，子分模块不再持有任何 module-level
 * 静态变量，便于回测脚本一处覆写参数后跑通全链路。
 */

export interface WcmiConfig {
  // ── 采样窗口 ──────────────────────────────────────────────────────
  /**
   * 所有子分计算所使用的尾部 K 线根数。
   * 默认 90 个交易日 ≈ 一个季度——足以暴露多次摆动、又能对市场风格切换
   * 保持灵敏。若个股可用历史 < `MIN_BARS` 直接返回 `null`；若处于
   * `MIN_BARS ≤ length < WINDOW` 区间则退化到全部可用历史，`WcmiSubscores`
   * 中的 `windowLen` 字段会记录真正使用的根数。
   */
  readonly WINDOW: number;

  /**
   * 进入打分流程所需的最小 K 线根数。
   * `bars.length < MIN_BARS` 的标的直接判定为样本不足、跳过本期排名，
   * 30 根 ≈ 6 个交易周，足够估计自相关、yang 比例、回撤等基础统计量。
   */
  readonly MIN_BARS: number;

  // ── 子分 1：rhythm（节奏） ───────────────────────────────────────
  /**
   * 日收益 lag-1 自相关的"理想值"。
   * 子分按 `−|lag1_autocorr − RHYTHM_TARGET|` 打分，使日收益弱持续的
   * 标的得分最高——这正是干净摆动的自相关签名。纯随机游走 = 0，动量末
   * 端 = 较大正值，频繁反转 = 负值。0.15 是 A 股日线的经验甜区。
   */
  readonly RHYTHM_TARGET: number;

  /**
   * "一个完整摆动"对应的参考根数。
   * `swing_density` 按 `WINDOW / SWING_PERIOD_BARS` 归一，因此在 WINDOW=90
   * 下 density=1.0 意味着每约 15 根（≈ 3 周）出现一次峰谷循环——视觉上
   * 可辨认的中期摆动。
   */
  readonly SWING_PERIOD_BARS: number;

  // ── 子分 2：ma_support（均线支撑） ───────────────────────────────
  /**
   * 收盘价相对 ma20 平均涨幅的归一上限。
   * `mean(close − ma20) / ma20` 达到该阈值即给满分（+15% 视为充分远离
   * ma20 的强势状态）。阈值越大对"贴均线"风格越宽容。
   */
  readonly MA20_DIST_CAP: number;

  // ── 子分 3：up_wave_smoothness（上行波平滑度） ───────────────────
  /**
   * 单段最长 yang 连阳根数的归一上限。
   * 计算窗口内最长连续阳线长度，与该上限相除并 clip 到 [0,1]，达到 8 根
   * 即给满分。降低意味着对"短连阳"也愿意打高分。
   */
  readonly MAX_YANG_RUN_CAP: number;

  /**
   * 平均 yang 连阳根数的归一上限。
   * 全窗所有 yang 连击段的均值，与该上限相除并 clip 到 [0,1]，4 根饱和。
   */
  readonly MEAN_YANG_RUN_CAP: number;

  /**
   * 单段上行子波段内最大回撤比例的归一上限。
   * 平均 swing 回撤 / 该上限 → 越大越糟。0.05 表示平均 5% 的段内回撤
   * 即扣满分；调高则容忍较深的中途调整。
   */
  readonly MEAN_SWING_DD_CAP: number;

  /**
   * 上行子波段 OLS 拟合 R² 的默认值。
   * 当窗口内没有任何长度 ≥ `MIN_SEGMENT_BARS` 的合格上行段时，使用此值
   * 占位（避免无段标的被一刀切到 0），0.5 表示"中性、不奖励也不惩罚"。
   */
  readonly DEFAULT_SLOPE_R2: number;

  /**
   * 参与 OLS R² 平均的最小段长度。
   * 短于该值的上行段噪声占比过大，不纳入 R² 平均，仅参与 yang-run 与回撤
   * 统计。5 根 ≈ 一周。
   */
  readonly MIN_SEGMENT_BARS: number;

  // ── 子分 5：upper_shadow_clean（上影线"干净度"） ────────────────
  /**
   * `upper_shadow / body` 的饱和阈值。
   * 比值达到该阈值，单根 K 的惩罚饱和至 1.0（即"上影线 ≥ 实体 1.5 倍"
   * 算作完全坏点），低于该阈值线性缩放。阈值越大越宽松。
   */
  readonly SHADOW_BODY_THR: number;

  /**
   * `upper_shadow / day_range` 的饱和阈值。
   * 比值达到该阈值，单根 K 的惩罚饱和至 1.0。0.4 表示上影线占当日振幅
   * ≥ 40% 即完全扣分。
   */
  readonly SHADOW_RANGE_THR: number;

  /**
   * 上影线惩罚计算时 body / range 的最小除数（单位：% of prevClose）。
   * 防止极小实体 / 振幅触发除以接近 0 的数值放大噪声。0.5% 是 A 股一档
   * 价差的典型量级。
   */
  readonly SHADOW_MIN_DIVISOR_PCT: number;

  // ── 子分 6：stage_gain（区间涨幅） ──────────────────────────────
  /**
   * 区间涨幅子分中"近期出现历史新高"的额外加权。
   * `argmax(close) / (n − 1)` ∈ [0, 1]，乘以该系数后加入最终得分；
   * 20 表示在窗口最新一根创新高时直接 +20 分，奖励"涨在最近"的标的，
   * 抑制"早涨完、近期阴跌"的形态。
   */
  readonly STAGE_RECENCY_BIAS: number;

  // ── 子分 7：crash_avoidance（防崩盘） ───────────────────────────
  /**
   * 单日跌幅"崩盘日"阈值（正数，单位 %）。
   * `change_pct < -CRASH_DAY_THR` 的根计入 `crash_days` 并喂入烈度项。
   * 7% 能捕捉真正的恐慌日，又不会把成长股常规 3–5% 波动误判为崩盘。
   */
  readonly CRASH_DAY_THR: number;

  /**
   * 崩盘日数量的归一上限。
   * `crash_days / CRASH_COUNT_CAP` 先除后 clip 到 1，4 个崩盘日即饱和——
   * 防止某一只极端波动股霸占整个百分位排名。
   */
  readonly CRASH_COUNT_CAP: number;

  /**
   * 未被收复的跳空低开阈值（负数，单位 %）。
   * 满足 `open < prev_close × (1 + GAP_DOWN_THR/100)` 且当日未收阳的根
   * 被标记；-2 能捕捉有意义的跳空，不会被 -0.5% 的常规低开触发。
   */
  readonly GAP_DOWN_THR: number;

  /**
   * 跳空低开日数量的归一上限，与 `CRASH_COUNT_CAP` 同义。
   * 90 根窗口内 6 个未收复低开即饱和。
   */
  readonly GAP_DOWN_CAP: number;

  /**
   * 崩盘烈度（平均超额跌幅）的归一跨度（单位 %）。
   * `mean(|change|) − CRASH_DAY_THR` 再除以该跨度并 clip 到 1。5% 意味着
   * 平均比阈值再深 5%（如 -12% vs 阈值 7%）即烈度饱和。
   */
  readonly CRASH_SEVERITY_SPAN_PCT: number;

  // ── 子分 8：recent_strength（近端强度 + 连阴 + 回撤） ───────────
  /**
   * 短期"当前是否健康"视图的尾部根数。
   * 默认 10 ≈ 最近两周，足以识别多日回调而又不会被单根噪声主导。
   * 必须满足 2 ≤ RECENT_WINDOW ≤ WINDOW。
   */
  readonly RECENT_WINDOW: number;

  /**
   * 近端"最长连阴根数"的归一上限。
   * 最近 `RECENT_WINDOW` 内最长 `close < open` 连击长度达到 5 根即
   * 完全清零连阴项；调低意味着更严苛（例如 3 时三连阴就扣满）。
   */
  readonly RECENT_YIN_RUN_CAP: number;

  /**
   * 近端"距窗口高点回撤"的归一上限。
   * `(window_high − close[-1]) / window_high` 达到该比例即完全清零回撤项。
   * 0.15 ≈ 15% 即"我不应该追入"的常用阈值。
   */
  readonly RECENT_PULLBACK_CAP: number;

  /**
   * 近端 `RECENT_WINDOW` 根尾部收益的归一跨度。
   * `recent_ret ≥ +RECENT_RET_SCALE` 给满分 1.0；`≤ -RECENT_RET_SCALE` 给
   * 0.0，中间线性。0.10 表示 ±10% 即两端饱和。
   */
  readonly RECENT_RET_SCALE: number;

  /**
   * 近端强度子分中"recent_ret 分量"的内部权重。
   * 三个内部分量（recent_ret / yin_run / pullback）权重需手动保证 ≈ 1。
   * 默认 0.40 表明近端收益的话语权最高。
   */
  readonly RECENT_W_RET: number;

  /**
   * 近端强度子分中"最长连阴分量"的内部权重。
   * 默认 0.35 与 RECENT_W_RET 相当——用户特别要求的"最近连续阴线"信号
   * 必须强势压制 90 日舞台涨幅。
   */
  readonly RECENT_W_YIN_RUN: number;

  /**
   * 近端强度子分中"距窗口高点回撤分量"的内部权重。
   * 默认 0.25，比另外两项稍弱——窗口高点已被 stage_gain 间接覆盖，避免
   * 重复扣分。
   */
  readonly RECENT_W_PULLBACK: number;

  // ── 组合权重（不必和为 100，最终按 `Σ w_k` 归一；
  //    调参经 7 轮回测得到，理由见 docs/perf/wcmi-redesign-backtest.md） ──
  /**
   * `rhythm` 子分（lag-1 autocorr + 摆动密度）权重。
   * 调到 0：在尾部 60 日涨幅最强的 universe 中 `swing_density ≥ 2` 已让
   * label_rhythm 饱和，对排名几乎只贡献噪声。
   */
  readonly W_RHYTHM: number;

  /**
   * `ma_support` 子分（站上 ma20/60 比例 + 多头排列 + 均距）权重。
   * 调到 3——小而非零的"美学组"打破平局用。
   */
  readonly W_MA_SUPPORT: number;

  /**
   * `up_wave_smoothness` 子分（yang-run + 段内回撤 + OLS R²）权重。
   * 调到 3——同样是"美学组"打破平局角色。
   */
  readonly W_UP_WAVE: number;

  /**
   * `yang_dominance` 子分（close > open 根的比例）权重。
   * 调到 3——同 W_MA_SUPPORT。
   */
  readonly W_YANG_DOM: number;

  /**
   * `upper_shadow_clean` 子分（1 − 加权平均上影线惩罚）权重。
   * 调到 3——原设计中最重的"美学组"权重（20），但回测表明顶部档位与
   * label_aesthetic 相关性弱甚至为负，故并入 4×3 平局组。
   */
  readonly W_SHADOW_CLEAN: number;

  /**
   * `stage_gain` 子分（r_window + range_gain + 近期加权）权重。
   * 调到 28——stage_gain 是过滤意图的主轴，但顶部档位原始涨幅会饱和，
   * 需要 crash_avoidance 进一步辨别。
   */
  readonly W_STAGE_GAIN: number;

  /**
   * `crash_avoidance` 子分（崩盘日数 + 烈度 + 跳空低开数）权重。
   * 从 60 → 30：增加 recent_strength 后，crash_avoidance 专注于单日尾部
   * 事件，慢慢"阴跌"由 recent_strength 接管。
   */
  readonly W_CRASH_AVOID: number;

  /**
   * `recent_strength` 子分（近端收益 + 连阴 + 距高点回撤）权重。
   * 默认 30，与 crash_avoidance 同量级——一起保证"90 日涨幅强但当前正在
   * 连续阴跌"的股票排名低于同样涨幅且仍在上行的股票。调高可进一步压制
   * 任何形式的近端弱势。
   */
  readonly W_RECENT_STRENGTH: number;

  // ── 输出标度 ──────────────────────────────────────────────────────
  /**
   * 组合 WCMI 分数的输出上限。
   * 组合 = `(WCMI_TOTAL_SCALE / Σ w_k) × Σ (w_k × pct_k)`，每个
   * `pct_k ∈ [0, 1]` 为横截面分位数。`WCMI_TOTAL_SCALE = 1000` 时分布
   * 区间 [0, 1000]，中位数 ≈ 500。
   */
  readonly WCMI_TOTAL_SCALE: number;
}

export const WCMI_CONFIG: WcmiConfig = {
  WINDOW: 90,
  MIN_BARS: 30,
  RHYTHM_TARGET: 0.15,
  SWING_PERIOD_BARS: 15,
  MA20_DIST_CAP: 0.15,
  MAX_YANG_RUN_CAP: 8,
  MEAN_YANG_RUN_CAP: 4,
  MEAN_SWING_DD_CAP: 0.05,
  DEFAULT_SLOPE_R2: 0.5,
  MIN_SEGMENT_BARS: 5,
  SHADOW_BODY_THR: 1.5,
  SHADOW_RANGE_THR: 0.4,
  SHADOW_MIN_DIVISOR_PCT: 0.5,
  STAGE_RECENCY_BIAS: 20,
  CRASH_DAY_THR: 7,
  CRASH_COUNT_CAP: 4,
  GAP_DOWN_THR: -2,
  GAP_DOWN_CAP: 6,
  CRASH_SEVERITY_SPAN_PCT: 5,
  RECENT_WINDOW: 10,
  RECENT_YIN_RUN_CAP: 5,
  RECENT_PULLBACK_CAP: 0.15,
  RECENT_RET_SCALE: 0.1,
  RECENT_W_RET: 0.4,
  RECENT_W_YIN_RUN: 0.35,
  RECENT_W_PULLBACK: 0.25,
  W_RHYTHM: 0,
  W_MA_SUPPORT: 3,
  W_UP_WAVE: 3,
  W_YANG_DOM: 3,
  W_SHADOW_CLEAN: 3,
  W_STAGE_GAIN: 28,
  W_CRASH_AVOID: 30,
  W_RECENT_STRENGTH: 30,
  WCMI_TOTAL_SCALE: 1000,
} as const;

export interface WcmiSubscores {
  readonly rhythm: number;
  readonly maSupport: number;
  readonly upWaveSmoothness: number;
  readonly yangDominance: number;
  readonly upperShadowClean: number;
  readonly stageGain: number;
  readonly crashAvoidance: number;
  /** 近端动量 + 连阴惩罚 + 距高点回撤，详见 `recent-strength.ts`。 */
  readonly recentStrength: number;
  readonly windowLen: number;
  readonly passesGate: boolean;
}

export interface WcmiPctBreakdown {
  readonly rhythm: number;
  readonly maSupport: number;
  readonly upWaveSmoothness: number;
  readonly yangDominance: number;
  readonly upperShadowClean: number;
  readonly stageGain: number;
  readonly crashAvoidance: number;
  readonly recentStrength: number;
}

export interface WcmiScore {
  readonly composite: number;
  readonly pct: WcmiPctBreakdown;
}

export interface ScoringInput {
  readonly code: string;
  readonly raw: WcmiSubscores;
}
