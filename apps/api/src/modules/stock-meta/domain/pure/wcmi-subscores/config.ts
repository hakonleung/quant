/**
 * WCMI v2 评分引擎的运行期参数配置。
 *
 * 所有可调常量（采样窗口、子分内部公式权重、饱和阈值、组合权重、
 * 输出标度）集中在此文件，按子分分组、每组顶部标注公式形态，便于
 * "看到数字 → 立即看到公式与含义 → 修改"。
 *
 * 默认值来自 `apps/api/scripts/wcmi-backtest.ts` 的多轮回测收敛结果，
 * 调参逐轮日志：`docs/perf/wcmi-redesign-backtest.md`。
 *
 * 子分模块（rhythm / ma-support / up-wave / upper-shadow / stage-gain /
 * crash-avoidance / recent-strength / yang-dominance）通过 `WcmiConfig`
 * 接口消费此对象；模块内部不得持有任何 module-level 静态常量。
 */

import { PERMANENT_BLACKLIST } from '@quant/shared';

import type { WcmiConfig } from './types.js';

export const WCMI_CONFIG: WcmiConfig = {
  // ═══════════════════════════════════════════════════════════════════
  // 采样窗口
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 所有子分计算所使用的尾部 K 线根数。
   * 默认 90 个交易日 ≈ 一个季度——足以暴露多次摆动、又能对市场风格切换
   * 保持灵敏。若个股可用历史 < `MIN_BARS` 直接返回 `null`；若处于
   * `MIN_BARS ≤ length < WINDOW` 区间则退化到全部可用历史，
   * `WcmiSubscores` 中的 `windowLen` 字段会记录真正使用的根数。
   */
  WINDOW: 35,

  /**
   * 进入打分流程所需的最小 K 线根数。
   * `bars.length < MIN_BARS` 的标的直接判定为样本不足、跳过本期排名；
   * 30 根 ≈ 6 个交易周，足够估计自相关、yang 比例、回撤等基础统计量。
   */
  MIN_BARS: 15,

  // ═══════════════════════════════════════════════════════════════════
  // 子分 1: rhythm（节奏）
  //   raw = RHYTHM_W_AUTOCORR × clip(autocorrScore / RHYTHM_AUTOCORR_SCALE, -1, 1)
  //       + RHYTHM_W_SWING    × (clip(swingDensity, 0, RHYTHM_SWING_DENSITY_CAP) - 1)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 日收益 lag-1 自相关的"理想值"。
   * 子分按 `−|lag1_autocorr − RHYTHM_TARGET|` 打分，使日收益弱持续的
   * 标的得分最高——这正是干净摆动的自相关签名。纯随机游走 = 0，动量末
   * 端 = 较大正值，频繁反转 = 负值。0.15 是 A 股日线的经验甜区。
   */
  RHYTHM_TARGET: 0.15,

  /**
   * "一个完整摆动"对应的参考根数。
   * `swing_density` 按 `WINDOW / SWING_PERIOD_BARS` 归一，因此在 WINDOW=90
   * 下 density=1.0 意味着每约 15 根（≈ 3 周）出现一次峰谷循环——视觉上
   * 可辨认的中期摆动。
   */
  SWING_PERIOD_BARS: 15,

  /**
   * 自相关偏差项的归一标度。
   * `autocorrScore = −|autocorr − RHYTHM_TARGET|` 已为非正数，
   * 除以 0.5 再 clip 到 [-1, 1]：偏差 0 → 1（满分），偏差 ≥ 0.5 → -1。
   * 调大对偏离 target 更宽容。
   */
  RHYTHM_AUTOCORR_SCALE: 0.5,

  /**
   * 摆动密度的归一上限。
   * `swingDensity` clip 到 [0, 2] 再 −1 → [-1, 1]：1 倍密度（与窗口
   * 期望摆动数一致）→ 0；2 倍及以上 → 1（饱和）；0 → -1。
   */
  RHYTHM_SWING_DENSITY_CAP: 2,

  /**
   * rhythm 子分内部权重：自相关项。
   * 默认 0.6，强调"日收益是否表现出干净摆动的自相关结构"。
   */
  RHYTHM_W_AUTOCORR: 0.6,

  /**
   * rhythm 子分内部权重：摆动密度项。
   * 默认 0.4，与 RHYTHM_W_AUTOCORR 互补，两项之和 = 1。
   */
  RHYTHM_W_SWING: 0.4,

  // ═══════════════════════════════════════════════════════════════════
  // 子分 2: ma_support（均线支撑）
  //   raw = MA_W_ABOVE_MA5  × rate(close>ma5)
  //       + MA_W_ABOVE_MA10 × rate(close>ma10)
  //       + MA_W_ABOVE_MA20 × rate(close>ma20)
  //   按"站上更短均线信号更强"的次序递减加权；ma60 不参与。
  // ═══════════════════════════════════════════════════════════════════

  /** ma_support 内部权重：收盘站上 ma5 比例。默认 0.5（主项，最快均线）。 */
  MA_W_ABOVE_MA5: 0.5,

  /** ma_support 内部权重：收盘站上 ma10 比例。默认 0.3。 */
  MA_W_ABOVE_MA10: 0.3,

  /** ma_support 内部权重：收盘站上 ma20 比例。默认 0.2。 */
  MA_W_ABOVE_MA20: 0.2,

  // ═══════════════════════════════════════════════════════════════════
  // 子分 3: up_wave_smoothness（上行波平滑度）
  //   raw = UP_WAVE_W_MAX_YANG  × clip(maxYangRun / MAX_YANG_RUN_CAP, 0, 1)
  //       + UP_WAVE_W_MEAN_YANG × clip(meanYangRun / MEAN_YANG_RUN_CAP, 0, 1)
  //       + UP_WAVE_W_SWING_DD  × (1 - clip(meanSwingDd / MEAN_SWING_DD_CAP, 0, 1))
  //       + UP_WAVE_W_SLOPE_R2  × meanSlopeR2
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 单段最长 yang 连阳根数的归一上限。
   * 计算窗口内最长连续阳线长度，与该上限相除并 clip 到 [0,1]，达到 8 根
   * 即给满分。降低意味着对"短连阳"也愿意打高分。
   */
  MAX_YANG_RUN_CAP: 10,

  /**
   * 平均 yang 连阳根数的归一上限。
   * 全窗所有 yang 连击段的均值，与该上限相除并 clip 到 [0,1]，4 根饱和。
   */
  MEAN_YANG_RUN_CAP: 4,

  /**
   * 单段上行子波段内最大回撤比例的归一上限。
   * 平均 swing 回撤 / 该上限 → 越大越糟。0.05 表示平均 5% 的段内回撤
   * 即扣满分；调高则容忍较深的中途调整。
   */
  MEAN_SWING_DD_CAP: 0.06,

  /**
   * 上行子波段 OLS 拟合 R² 的默认值。
   * 当窗口内没有任何长度 ≥ `MIN_SEGMENT_BARS` 的合格上行段时，使用此值
   * 占位（避免无段标的被一刀切到 0），0.5 表示"中性、不奖励也不惩罚"。
   */
  DEFAULT_SLOPE_R2: 0.5,

  /**
   * 参与 OLS R² 平均的最小段长度。
   * 短于该值的上行段噪声占比过大，不纳入 R² 平均，仅参与 yang-run 与回撤
   * 统计。5 根 ≈ 一周。
   */
  MIN_SEGMENT_BARS: 5,

  /** up_wave 内部权重：最长连阳。默认 0.35（最大项）。 */
  UP_WAVE_W_MAX_YANG: 0.2,

  /** up_wave 内部权重：平均连阳。默认 0.25。 */
  UP_WAVE_W_MEAN_YANG: 0.4,

  /** up_wave 内部权重：段内回撤的"反向"得分。默认 0.25。 */
  UP_WAVE_W_SWING_DD: 0.25,

  /** up_wave 内部权重：上行段 OLS R²。默认 0.15。 */
  UP_WAVE_W_SLOPE_R2: 0.15,

  // ═══════════════════════════════════════════════════════════════════
  // 子分 5: upper_shadow_clean（上影线"干净度"）
  //   bars_used       = tail(SHADOW_WINDOW)
  //   per_bar_penalty = (upper_shadow >= SHADOW_LONG_PCT) ? 1 : 0
  //   weight          = (close > open) ? SHADOW_YANG_WEIGHT : SHADOW_YIN_WEIGHT
  //   raw             = 1 - Σ(weight × penalty) / Σ(weight)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * upper_shadow_clean 独立观察窗口（尾部 K 线根数）。
   * 与全局 WINDOW 解耦——长上影"冲高失败"是短期形态信号，过长窗口会被
   * 早已修复的孤立长影稀释。20 ≈ 一个月，捕捉当前阶段的抛压。
   * `bars.length < SHADOW_WINDOW` 时退化为全部可用历史。
   */
  SHADOW_WINDOW: 20,

  /**
   * "长上影线"判定阈值（单位：% of prevClose）。
   * `upper_shadow >= SHADOW_LONG_PCT` 视为一根长上影 K，单根惩罚 = 1；
   * 否则惩罚 = 0。
   */
  SHADOW_LONG_PCT: 4,

  /**
   * 阳线（close > open）上影线惩罚的加权。
   * 默认 1.5——阳线长上影是"冲高回落、失败上攻"的强负信号。
   */
  SHADOW_YANG_WEIGHT: 1,

  /**
   * 阴线（close ≤ open）上影线惩罚的加权。
   * 默认 1.0——阴线的长上影意义弱于阳线，仍计入但权重正常。
   */
  SHADOW_YIN_WEIGHT: 1,

  // ═══════════════════════════════════════════════════════════════════
  // 子分 6: stage_gain（区间涨幅）
  //   value = STAGE_W_R_WINDOW   × rWindow           (% of window total return)
  //         + STAGE_W_RANGE_GAIN × rangeGain         (% from window low)
  //         + STAGE_RECENCY_BIAS × (argmaxClose / (n - 1))
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 区间涨幅子分中"近期出现历史新高"的额外加权。
   * `argmax(close) / (n − 1)` ∈ [0, 1]，乘以该系数后加入最终得分；
   * 20 表示在窗口最新一根创新高时直接 +20 分，奖励"涨在最近"的标的，
   * 抑制"早涨完、近期阴跌"的形态。
   */
  STAGE_RECENCY_BIAS: 20,

  /**
   * stage_gain 内部权重：窗口首末收盘的总收益（%）。
   * 默认 0.5——"区间起到末的实际涨幅"是 stage_gain 的核心。
   */
  STAGE_W_R_WINDOW: 0.5,

  /**
   * stage_gain 内部权重：窗口最低点到末根的反弹幅度（%）。
   * 默认 0.3——补充奖励"曾经深跌、但已经走出"的标的，相对 r_window
   * 是次级项。
   */
  STAGE_W_RANGE_GAIN: 0.3,

  // ═══════════════════════════════════════════════════════════════════
  // 子分 7: crash_avoidance（防崩盘）
  //   raw = 1 - CRASH_W_COUNT    × clip(crashDays   / CRASH_COUNT_CAP, 0, 1)
  //           - CRASH_W_SEVERITY × clip(excessSev   / CRASH_SEVERITY_SPAN_PCT, 0, 1)
  //           - CRASH_W_GAP_DOWN × clip(gapDownDays / GAP_DOWN_CAP, 0, 1)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 单日跌幅"崩盘日"阈值（正数，单位 %）。
   * `change_pct < -CRASH_DAY_THR` 的根计入 `crash_days` 并喂入烈度项。
   * 7% 能捕捉真正的恐慌日，又不会把成长股常规 3–5% 波动误判为崩盘。
   */
  CRASH_DAY_THR: 6,

  /**
   * 崩盘日数量的归一上限。
   * `crash_days / CRASH_COUNT_CAP` 先除后 clip 到 1，4 个崩盘日即饱和——
   * 防止某一只极端波动股霸占整个百分位排名。
   */
  CRASH_COUNT_CAP: 10,

  /**
   * 未被收复的跳空低开阈值（负数，单位 %）。
   * 满足 `open < prev_close × (1 + GAP_DOWN_THR/100)` 且当日未收阳的根
   * 被标记；-2 能捕捉有意义的跳空，不会被 -0.5% 的常规低开触发。
   */
  GAP_DOWN_THR: -2,

  /**
   * 跳空低开日数量的归一上限，与 `CRASH_COUNT_CAP` 同义。
   * 90 根窗口内 6 个未收复低开即饱和。
   */
  GAP_DOWN_CAP: 10,

  /**
   * 崩盘烈度（平均超额跌幅）的归一跨度（单位 %）。
   * `mean(|change|) − CRASH_DAY_THR` 再除以该跨度并 clip 到 1。5% 意味着
   * 平均比阈值再深 5%（如 -12% vs 阈值 7%）即烈度饱和。
   */
  CRASH_SEVERITY_SPAN_PCT: 2,

  /** crash_avoidance 内部权重：崩盘日"数量"扣分。默认 0.5（主项）。 */
  CRASH_W_COUNT: 0.5,

  /** crash_avoidance 内部权重：崩盘日"烈度"扣分。默认 0.3。 */
  CRASH_W_SEVERITY: 0.3,

  /** crash_avoidance 内部权重：未收复跳空低开"数量"扣分。默认 0.2。 */
  CRASH_W_GAP_DOWN: 0.2,

  // ═══════════════════════════════════════════════════════════════════
  // 子分 8: recent_strength（近端强度 + 连阴 + 回撤）
  //   raw = RECENT_W_RET      × retScore
  //       + RECENT_W_YIN_RUN  × yinScore
  //       + RECENT_W_PULLBACK × pullbackScore
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 短期"当前是否健康"视图的尾部根数。
   * 默认 10 ≈ 最近两周，足以识别多日回调而又不会被单根噪声主导。
   * 必须满足 2 ≤ RECENT_WINDOW ≤ WINDOW。
   */
  RECENT_WINDOW: 5,

  /**
   * 近端"最长连阴根数"的归一上限。
   * 最近 `RECENT_WINDOW` 内最长 `close < open` 连击长度达到 5 根即
   * 完全清零连阴项；调低意味着更严苛（例如 3 时三连阴就扣满）。
   */
  RECENT_YIN_RUN_CAP: 5,

  /**
   * 近端"距窗口高点回撤"的归一上限。
   * `(window_high − close[-1]) / window_high` 达到该比例即完全清零回撤项。
   * 0.15 ≈ 15% 即"我不应该追入"的常用阈值。
   */
  RECENT_PULLBACK_CAP: 0.2,

  /**
   * 近端 `RECENT_WINDOW` 根尾部收益的归一跨度。
   * `recent_ret ≥ +RECENT_RET_SCALE` 给满分 1.0；`≤ -RECENT_RET_SCALE` 给
   * 0.0，中间线性。0.10 表示 ±10% 即两端饱和。
   */
  RECENT_RET_SCALE: 0.15,

  /**
   * 近端强度子分中"recent_ret 分量"的内部权重。
   * 三个内部分量（recent_ret / yin_run / pullback）权重需手动保证 ≈ 1。
   * 默认 0.40 表明近端收益的话语权最高。
   */
  RECENT_W_RET: 0.4,

  /**
   * 近端强度子分中"最长连阴分量"的内部权重。
   * 默认 0.35 与 RECENT_W_RET 相当——用户特别要求的"最近连续阴线"信号
   * 必须强势压制 90 日舞台涨幅。
   */
  RECENT_W_YIN_RUN: 0.35,

  /**
   * 近端强度子分中"距窗口高点回撤分量"的内部权重。
   * 默认 0.25，比另外两项稍弱——窗口高点已被 stage_gain 间接覆盖，避免
   * 重复扣分。
   */
  RECENT_W_PULLBACK: 0.25,

  // ═══════════════════════════════════════════════════════════════════
  // 组合权重（不必和为 100，最终按 Σ w_k 归一；调参经 7 轮回测得到，
  // 理由见 docs/perf/wcmi-redesign-backtest.md）
  // ═══════════════════════════════════════════════════════════════════

  /**
   * `rhythm` 子分（lag-1 autocorr + 摆动密度）权重。
   * 调到 0：在尾部 60 日涨幅最强的 universe 中 `swing_density ≥ 2` 已让
   * label_rhythm 饱和，对排名几乎只贡献噪声。
   */
  W_RHYTHM: 0,

  /**
   * `ma_support` 子分权重。
   * 调到 3——小而非零的"美学组"打破平局用。
   */
  W_MA_SUPPORT: 12,

  /**
   * `up_wave_smoothness` 子分权重。
   * 调到 3——同样是"美学组"打破平局角色。
   */
  W_UP_WAVE: 20,

  /**
   * `yang_dominance` 子分权重。
   * 调到 3——同 W_MA_SUPPORT。
   */
  W_YANG_DOM: 8,

  /**
   * `upper_shadow_clean` 子分权重。
   * 调到 3——原设计中最重的"美学组"权重（20），但回测表明顶部档位与
   * label_aesthetic 相关性弱甚至为负，故并入 4×3 平局组。
   */
  W_SHADOW_CLEAN: 10,

  /**
   * `stage_gain` 子分权重。
   * 调到 28——stage_gain 是过滤意图的主轴，但顶部档位原始涨幅会饱和，
   * 需要 crash_avoidance 进一步辨别。
   */
  W_STAGE_GAIN: 25,

  /**
   * `crash_avoidance` 子分权重。
   * 从 60 → 30：增加 recent_strength 后，crash_avoidance 专注于单日尾部
   * 事件，慢慢"阴跌"由 recent_strength 接管。
   */
  W_CRASH_AVOID: 15,

  /**
   * `recent_strength` 子分权重。
   * 默认 30，与 crash_avoidance 同量级——一起保证"90 日涨幅强但当前正在
   * 连续阴跌"的股票排名低于同样涨幅且仍在上行的股票。调高可进一步压制
   * 任何形式的近端弱势。
   */
  W_RECENT_STRENGTH: 20,

  /**
   * 组合 WCMI 分数的输出上限。
   * 组合 = `(WCMI_TOTAL_SCALE / Σ w_k) × Σ (w_k × pct_k)`，每个
   * `pct_k ∈ [0, 1]` 为横截面分位数。`WCMI_TOTAL_SCALE = 1000` 时分布
   * 区间 [0, 1000]，中位数 ≈ 500。
   */
  WCMI_TOTAL_SCALE: 1000,

  // ═══════════════════════════════════════════════════════════════════
  // 永久黑名单
  //   命中即直接当作 gate-failed，分数返回 null，不进入横截面排名。
  //   当前列入的均为长期高波动 / 高风险标的（科创板 CDR / 退市风险 / 长期
  //   连续亏损），手工维护。
  // ═══════════════════════════════════════════════════════════════════
  PERMANENT_BLACKLIST,
} as const;
