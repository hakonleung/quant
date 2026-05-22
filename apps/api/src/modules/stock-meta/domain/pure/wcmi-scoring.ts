/**
 * Cross-sectional WCMI scoring engine.
 *
 * Architecture (batch-only — single-code path returns null for wcmi):
 *
 *   Phase A  extractRawFeatures(bars) per code   → WcmiRawFeatures
 *   Phase B  scoreUniverse(items)
 *            1. survivor filter (history + gate)
 *            2. percentile tables for each ranked dimension
 *            3. compose S_mom + S_exp via `bor()`; S_timing & P_fomo
 *               are absolute and already computed in raw
 *            4. percentile tables for the four module sums
 *            5. final = scale · Σ w_module · norm(module)
 *               clipped to ±{@link WCMI_CONFIG.WCMI_TOTAL_SCALE}
 *               (default ±1000).  `scale = TOTAL / Σ_positive(w)`
 *               so each module contributes `±(w/Σ_positive)·TOTAL`.
 *
 * `bor` is a step function (top-1 % → +20, …, other → −20). Ties use
 * average rank. Negative-direction features are flipped before the
 * rank lookup so "rank from top" always means "best".
 *
 * Output is stored as a signed integer-ish value in `[-1000, +1000]`
 * (Sharpe-style score, no `%` suffix). FE renders via the `ScoreCell`
 * helper in `apps/web/components/feat-eq-list/list-cells.tsx`.
 */

import type { BarLike } from './compute-metrics.js';

// ─────────────────────────────────────────────────────────────────
// Tunables (all in one place — bull-market default profile)
// ─────────────────────────────────────────────────────────────────

export const WCMI_CONFIG = {
  // ─── S_mom —— 多周期收益率复合（rank 输入） ─────────────────────────
  /** bor(rank_r5) 的权重。↑ = 更看重 1 周内冲刺；↓ = 减少短期噪音。
   *  推荐区间 1–4（保持 W_R10 主导）。 */
  W_R5: 1,
  /** bor(rank_r10) 的权重。1–2 周波段的主旋钮——这是用户明确的目标
   *  持有期。↑ = 更激进地押短期 swing。 */
  W_R10: 3,
  /** bor(rank_r20) 的权重。月度趋势确认项。↑ = 要求月线撑得住才能
   *  上榜；↓ = 让纯短期反弹也能挤进来。 */
  W_R20: 5,
  /** bor(rank_r60) 的权重。约 3 个月级别。低权重防止"高位横盘"
   *  统治榜单；如果想偏好长趋势老票而非新 swing，再调高它。 */
  W_R60: 2,
  /** bor(rank_r90) 的权重。约 4.5 个月级别，与 r60 同类。如果希望
   *  长期上涨股通过"横盘突破"而非纯 r90 权重再次出头，把这条留低，
   *  靠 {@link BREAKOUT_BONUS}。 */
  W_R90: 1,
  /** "横盘突破" 资格的 r90 下限（%）。↑ → 只有更稀少、更强劲的票
   *  才能拿到 bonus。100 ≈ "4.5 个月翻倍"。 */
  BREAKOUT_R90_THRESHOLD: 120,
  /** 横盘突破触发的 r5/r10 比例下限。↑ = 要求短期更强加速；
   *  ↓ = 容忍轻微停顿后再启动。0.8 ≈ "近 5 天速度 ≥ 近 10 天 80%"。*/
  BREAKOUT_R5_RATIO: 0.7,
  /** 满足上面两条件时直接加到 `S_mom_raw` 的绝对 bonus。和 rank
   *  复合并列；按 bor 单位调（每档 ±5）。 */
  BREAKOUT_BONUS: 20,

  // ─── S_exp —— 持股体验复合（rank 输入） ──────────────────────────
  /** bor(rank_kform_up_count) 的权重——光头大阳次数。排名靠前 →
   *  奖励大。"频繁强势封板"型。 */
  W_KFORM_UP: 5,
  /** bor(rank_kform_dn_count) 的权重，**方向 -1**——光脚大阴次数
   *  越多惩罚越重。 */
  W_KFORM_DN: 5,
  /** bor(rank_upper_shadow_count) 的权重，**方向 -1**——长上影
   *  （冲高回落）次数多 → 惩罚。 */
  W_UPPER_SHADOW: 20,
  /** bor(rank_lower_shadow_count) 的权重，**方向 +1**——长下影
   *  （回踩有人接）次数多 → 奖励。 */
  W_LOWER_SHADOW: 1,
  /** bor(rank_continuity_match_rate) 的权重——4 日全阳的匹配率。
   *  在意"走势质量"而非"涨幅"时调高它。 */
  W_CONTINUITY: 5,
  /** bor(rank_green_rate) 的权重——区间内"收涨日"占比，与连贯性
   *  互补（看总量 vs 看序列）。 */
  W_GREEN_RATE: 5,
  /** bor(rank_max_drawdown) 的权重，**方向 -1**——区间最大回撤越
   *  小越好。 */
  W_DRAWDOWN: 5,
  /** bor(rank_big_down_count) 的权重，**方向 -1**——change <
   *  -{@link BIG_DOWN_THR} 的天数多 → 大跌频繁 → 惩罚。"大涨"那
   *  一侧由 kform_up / 长上影 等专属项覆盖，不在这里重复计入。 */
  W_BIG_DOWN: 5,
  /** bor(rank_low_open_count) 的权重，**方向 -1**——`gap <
   *  {@link LOW_OPEN_GAP_THR}` 且收盘 ≤ 开盘（低开未拉回）的天数多
   *  → 频繁低开 → 惩罚。 */
  W_LOW_OPEN: 5,

  // ─── 回溯窗口 / 日内阈值 ────────────────────────────────────────
  /** S_exp 计数类指标的回溯窗口（bars 上限）。↑ = 历史视角更长但
   *  反应慢；↓ = 反应快但更噪。 */
  LOOKBACK_DAYS: 30,
  /** "大涨跌"阈值（% of prev_close）。|change| > BIG_MOVE 算大波动；
   *  kform_up/dn 识别和大波动计数都用它。6 % 覆盖主板涨跌停。 */
  BIG_MOVE: 6,
  /** 长上下影线阈值（% of prev_close）。upper_shadow / lower_shadow
   *  > LONG_SHADOW 才计入对应的影线计数。 */
  LONG_SHADOW: 3,
  /** "大振幅"阈值（% of prev_close）。当前仅用于最后一日异动检测，
   *  与 BIG_MOVE 对称。 */
  BIG_AMP: 6,
  /** 视为"光头/光脚"的影线上限。kform_up 要求 wickAboveBodyTop <
   *  SHAVED_SHADOW（传统口径："收在最高"）；kform_dn 同理用
   *  wickBelowBodyBottom < SHAVED_SHADOW（"收在最低"）。注意这里
   *  跟下面 LONG_SHADOW 使用的影线口径不同——LONG_SHADOW 用的是
   *  新的 H−O / C−L。 */
  SHAVED_SHADOW: 1.5,
  /** "大跌"阈值（% of prev_close）。`change < -BIG_DOWN_THR` 才计入
   *  大跌天数。默认 5——比 BIG_MOVE（7）宽松，因为我们想抓更广义的
   *  大幅下跌，而不只是涨停跌停级别。 */
  BIG_DOWN_THR: 6,
  /** 低开次数判定的 gap 阈值（% of prev_close, 负值）。`gap <
   *  LOW_OPEN_GAP_THR` 触发"低开"候选。-2 ≈ "开盘比昨收低 ≥ 2%"。 */
  LOW_OPEN_GAP_THR: -2,

  // ─── 连贯性（4 日全阳滚动窗） ───────────────────────────────────
  /** 连贯性扫描的窗口长度（bars）。 */
  CONT_WINDOW: 4,
  /** 一个窗口内"close > prev_close"的最少天数才算 match。4/4 =
   *  严格全阳；改成 3 等于放宽到"有一天回调没关系"。 */
  CONT_MIN_UP: 4,

  // ─── P_fomo —— 绝对值惩罚（不参与 rank，直接相加） ───────────────
  /** 触发"无量干拔"FOMO 罚的 r5 下限（%）。两个条件同时满足才罚：
   *  r5 > FOMO_R5_THR  AND  avg_turnover_5 < FOMO_TURNOVER_RATIO × avg_N。*/
  FOMO_R5_THR: 20,
  /** 近 5 日均换手 / 基准窗口均换手 的比例。低于这个比例 + r5 大
   *  = "无量干拔"。比例越小 → 触发越少 → 越保守。 */
  FOMO_TURNOVER_RATIO: 0.8,
  /** 计算上面这个比例时用的基准换手窗口（bars）。20 ≈ 一个月，
   *  既新近又稳定。 */
  FOMO_AVG_WINDOW: 10,
  /** 无量干拔触发时加到 P_fomo 的固定罚分。和 OB_* 调相对严重程度。*/
  FOMO_LOW_TURNOVER_PEN: 50,
  /** 视为"一字涨停候选"的最后一根 change（%）下限。9.5 % 给 10 %
   *  涨停留点小数边界。 */
  LIMIT_UP_CHG: 9.5,
  /** 一字涨停的最大允许振幅（%）——值越小越严格要求"全天无波幅"。*/
  LIMIT_UP_AMP_MAX: 5,
  /** 最后一根判定为一字涨停时加到 P_fomo 的固定罚分。"适度"——明天
   *  可能开板可买，不彻底剔除，让用户仍能看到。 */
  LIMIT_UP_PEN: 50,
  /** ma5 偏离 (bias_5) 进入超买惩罚的阈值（%）。牛市默认 12 %，
   *  调低 → 更严格的"离 ma5 太远"。 */
  BIAS5_OB: 12,
  /** ma10 偏离 (bias_10) 进入超买惩罚的阈值（%）。牛市默认 20 %，
   *  超过后按凸函数累加（见 OB_P）。 */
  BIAS10_OB: 20,
  /** `(bias_5 - BIAS5_OB)^OB_P` 的系数——控制 ma5 超买惩罚增长速度。*/
  OB_BIAS5_K: 1.1,
  /** `(bias_10 - BIAS10_OB)^OB_P` 的系数。比 ma5 更高，因为 ma10
   *  级别的超买更危险。 */
  OB_BIAS10_K: 1.2,
  /** 超买惩罚的凸性指数。1.3 = 温和凸（超 5 % 比超 1 % 罚 ≈ 8 倍）。*/
  OB_P: 1.3,

  // ─── S_timing —— 绝对值打分（不参与 rank） ─────────────────────
  /** 计算"贴近均线奖励"时的距离窗口（%）。距离超过它奖励 = 0，越
   *  靠近线性接近 `MA_*_BASE`。调大 → "贴近"的定义更宽松。 */
  MA_NEAR_RANGE: 4,
  /** 贴近 ma10 的最高奖励——用户偏好的买点。ma5/10/20 三档相互独立，
   *  取最大那档计分，不重复加。 */
  MA_10_BASE: 3,
  /** 贴近 ma5 的最高奖励。 */
  MA_5_BASE: 2,
  /** 贴近 ma20 的最高奖励。 */
  MA_20_BASE: 1,
  /** 单根 bar 触及 ma10 后收回（low ≤ ma10 AND close > ma10）的奖
   *  励——"均线支撑有效"。在 lookback 窗口里累加。 */
  MA10_TOUCH_REWARD: 2,
  /** 单根 bar 触及 ma5 后收回的奖励。 */
  MA5_TOUCH_REWARD: 2,
  /** 单根 bar 触及 ma20 后收回的奖励。 */
  MA20_TOUCH_REWARD: 2,
  /** 单根 bar 跌破 ma10 的惩罚——prev_close > ma10 AND close <
   *  ma10 AND change < MA10_BREAK_THR，"实质性破位"。 */
  MA10_BREAK_PEN: 3,
  /** 判定为 ma10 实质性跌破的 change 阈值（负数）。-2 → 只有跌
   *  ≥ 2 % 才算破位，避免被弱整理误判。 */
  MA10_BREAK_THR: -2,
  /** 跌破 ma5 的惩罚——比 ma10 轻（更接近正常波动）。 */
  MA5_BREAK_PEN: 2,
  /** 判定为 ma5 实质性跌破的 change 阈值。 */
  MA5_BREAK_THR: -2,
  /** 最后一根 |change| / 振幅超过此值才开始罚（次日反转风险）。
   *  牛市默认 8 %。 */
  LAST_DAY_THR: 5,
  /** `excess_change ^ LAST_P` 的系数——方向性异动那一部分。 */
  LAST_CHANGE_K: 1.5,
  /** `excess_amplitude ^ LAST_P` 的系数——振幅那一部分。 */
  LAST_AMP_K: 1.0,
  /** 最后一日异动罚的凸性指数。 */
  LAST_P: 1.5,

  // ─── Final 加权（各模块占总分的份额） ─────────────────────────
  // 下面的权重定义每个模块占 **总分上限** ({@link WCMI_TOTAL_SCALE})
  // 的"份额"。正向 3 项（mom/exp/timing）权重之和可任意，每项占总和
  // 的比例就是它能贡献到 final 的 `±share × TOTAL` 区间。P_fomo 用
  // 它的权重相对于正向和减去——最差 case 可能让 final 跌破 -TOTAL
  // 然后被对称 clip 兜底（用心如此：极端 unbuyable 票活该见底）。
  //
  // 以当前默认为例（正向 sum = 10）：
  //   norm(S_mom) ∈ [-1,+1] · 600 ⇒ ±600   (60 % 总分)
  //   norm(S_exp)            · 300 ⇒ ±300   (30 %)
  //   norm(S_timing)         · 100 ⇒ ±100   (10 %)
  //   norm(P_fomo) (减)      · 100 ⇒ ±100
  /** `norm(S_mom)` 分配到的份额——动能是主信号，最大权重。 */
  W_FINAL_MOM: 10,
  /** `norm(S_exp)` 分配到的份额——持股体验，次大权重。 */
  W_FINAL_EXP: 8,
  /** `norm(S_timing)` 分配到的份额——择时位点；小但非零，
   *  让买点不好的票被适度扣分。 */
  W_FINAL_TIMING: 4,
  /** `norm(P_fomo)` 分配到的份额（**减项**）——封顶 FOMO/不可参与
   *  类问题能把分数拖多低。 */
  W_FINAL_FOMO: 0,
  /** Final 分数的正向上限（同时也是对称 clip 的绝对值）。默认
   *  ±1000——FE 渲染舒服的整数级别。 */
  WCMI_TOTAL_SCALE: 1000,
} as const;

// ─────────────────────────────────────────────────────────────────
// Raw feature extraction — phase A, single-bar-walk per code
// ─────────────────────────────────────────────────────────────────

/** Per-bar derived percentages (vs prev close). `null` slots mean the
 *  bar's prev close was missing or non-positive.
 *
 *  Shadow definitions:
 *  - `wickAboveBodyTop` / `wickBelowBodyBottom` use the **traditional**
 *    body-top / body-bottom anchor (`max(O,C)` / `min(O,C)`) — these
 *    are what `kform_up` / `kform_dn` consult so the meaning of
 *    "光头大阳 / 光脚大阴" stays "closed at the day's high / low".
 *  - `upperShadow` / `lowerShadow` use the user-specified anchors:
 *      upper = H − O    (rallied above the open then sold off / not)
 *      lower = C − L    (held above the low / fell below close)
 *    These feed the {@link WcmiRawFeatures} long-upper-shadow and
 *    long-lower-shadow counts. */
interface BarMetrics {
  readonly change: number;
  readonly gap: number;
  /** H − O, normalised (long-upper-shadow count feature). */
  readonly upperShadow: number;
  /** C − L, normalised (long-lower-shadow count feature). */
  readonly lowerShadow: number;
  /** Traditional wick above body top — used for kform_up detection. */
  readonly wickAboveBodyTop: number;
  /** Traditional wick below body bottom — used for kform_dn detection. */
  readonly wickBelowBodyBottom: number;
  readonly amplitude: number;
  /** `close > open` — used to exclude "低开但拉回" bars from the
   *  low-open count (a gap-down that recovers intraday is not a bad
   *  holding-experience signal). */
  readonly closeAboveOpen: boolean;
}

/** All raw inputs the scoring engine needs from a single code.
 *  Either every field is populated, or the whole struct is `null`. */
export interface WcmiRawFeatures {
  // Returns — used for both gate (r10/r20) and ranking.
  readonly r5: number | null;
  readonly r10: number;
  readonly r20: number | null;
  readonly r60: number | null;
  readonly r90: number | null;
  /** Absolute bonus added to S_mom_raw after the rank composite. */
  readonly breakoutBonus: number;
  // S_exp ranked dimensions (counts / rates over the lookback tail).
  readonly kformUpCount: number;
  readonly kformDnCount: number;
  readonly upperShadowCount: number;
  readonly lowerShadowCount: number;
  readonly continuityMatchRate: number;
  readonly greenRate: number;
  readonly maxDrawdown: number;
  readonly bigDownCount: number;
  readonly lowOpenCount: number;
  // Absolute modules — already in score units.
  readonly sTimingAbsolute: number;
  readonly pFomoAbsolute: number;
}

export function extractRawFeatures(bars: readonly BarLike[]): WcmiRawFeatures | null {
  if (bars.length < 11) return null;
  // r10 is mandatory for the gate.
  const r10 = computeRet(bars, 10);
  if (r10 === null) return null;
  const r5 = computeRet(bars, 5);
  const r20 = computeRet(bars, 20);
  const r60 = computeRet(bars, 60);
  const r90 = computeRet(bars, 90);

  // Breakout bonus eligibility — needs r5, r10, r90 all present.
  let breakoutBonus = 0;
  if (
    r5 !== null &&
    r90 !== null &&
    r90 > WCMI_CONFIG.BREAKOUT_R90_THRESHOLD &&
    r5 >= r10 * WCMI_CONFIG.BREAKOUT_R5_RATIO
  ) {
    breakoutBonus = WCMI_CONFIG.BREAKOUT_BONUS;
  }

  // Bar-level metrics over the entire history (cheap; reused below).
  const bm = buildBarMetrics(bars);
  const lookback = Math.min(WCMI_CONFIG.LOOKBACK_DAYS, bars.length - 1);
  const tail = bm.slice(bm.length - lookback);

  // Count-based + rate-based features.
  const counts = countKlineForms(tail);
  const continuityMatchRate = computeContinuityMatchRate(tail);
  const greenRate = computeGreenRate(tail);
  const maxDrawdown = computeMaxDrawdown(bars, lookback);

  // Absolute modules (S_timing + P_fomo).
  const closes = bars.map((b) => b.close_qfq);
  const ma5 = movingAverage(closes, 5);
  const ma10 = movingAverage(closes, 10);
  const ma20 = movingAverage(closes, 20);
  const latestM = bm[bm.length - 1] ?? null;
  const latestClose = closes[closes.length - 1]!;
  const ma5Last = ma5[ma5.length - 1] ?? null;
  const ma10Last = ma10[ma10.length - 1] ?? null;
  const ma20Last = ma20[ma20.length - 1] ?? null;

  const sTimingAbsolute =
    proximityMax(latestClose, ma5Last, ma10Last, ma20Last) +
    accumulateMaSupport(bars, bm, ma5, ma10, ma20, lookback) +
    (latestM !== null ? lastDayAnomalyPenalty(latestM) : 0);

  const pFomoAbsolute =
    overboughtPenalty(latestClose, ma5Last, ma10Last) +
    lowTurnoverFomoPenalty(bars, r5) +
    (latestM !== null && isLimitUpSealed(bars, latestM) ? WCMI_CONFIG.LIMIT_UP_PEN : 0);

  return {
    r5,
    r10,
    r20,
    r60,
    r90,
    breakoutBonus,
    kformUpCount: counts.kformUpCount,
    kformDnCount: counts.kformDnCount,
    upperShadowCount: counts.upperShadowCount,
    lowerShadowCount: counts.lowerShadowCount,
    continuityMatchRate,
    greenRate,
    maxDrawdown,
    bigDownCount: counts.bigDownCount,
    lowOpenCount: counts.lowOpenCount,
    sTimingAbsolute,
    pFomoAbsolute,
  };
}

// ─────────────────────────────────────────────────────────────────
// Universe scoring — phase B
// ─────────────────────────────────────────────────────────────────

export interface ScoringInput {
  readonly code: string;
  readonly raw: WcmiRawFeatures;
}

/**
 * Score every code against the universe. Returns a Map keyed by
 * `code`; values are `final ∈ [-1, +1]` for survivors, `null` for
 * codes that fail the trend gate (`ret_10d ≤ 0` or `ret_20d` present
 * and `≤ 0`).
 */
export function scoreUniverse(items: readonly ScoringInput[]): Map<string, number | null> {
  const out = new Map<string, number | null>();
  if (items.length === 0) return out;

  // Survivor filter — gate-failed codes get null and don't enter the
  // rank tables (they would warp the distribution otherwise).
  const survivors: ScoringInput[] = [];
  for (const it of items) {
    const r10 = it.raw.r10;
    if (r10 <= 0) {
      out.set(it.code, null);
      continue;
    }
    const r20 = it.raw.r20;
    if (r20 !== null && r20 <= 0) {
      out.set(it.code, null);
      continue;
    }
    survivors.push(it);
  }
  if (survivors.length === 0) return out;

  // ── Phase B.2: rank tables over survivors ─────────────────────
  const sorted = buildRankTables(survivors);

  // ── Phase B.3: compute S_mom_raw + S_exp_raw + S_timing + P_fomo per survivor
  type ModuleSums = {
    sMom: number;
    sExp: number;
    sTiming: number;
    pFomo: number;
  };
  const moduleSums = new Map<string, ModuleSums>();
  for (const it of survivors) {
    const r = it.raw;
    const sMom =
      WCMI_CONFIG.W_R5 * borFor(sorted.r5, r.r5, +1) +
      WCMI_CONFIG.W_R10 * borFor(sorted.r10, r.r10, +1) +
      WCMI_CONFIG.W_R20 * borFor(sorted.r20, r.r20, +1) +
      WCMI_CONFIG.W_R60 * borFor(sorted.r60, r.r60, +1) +
      WCMI_CONFIG.W_R90 * borFor(sorted.r90, r.r90, +1) +
      r.breakoutBonus;
    const sExp =
      WCMI_CONFIG.W_KFORM_UP * borFor(sorted.kformUpCount, r.kformUpCount, +1) +
      WCMI_CONFIG.W_KFORM_DN * borFor(sorted.kformDnCount, r.kformDnCount, -1) +
      WCMI_CONFIG.W_UPPER_SHADOW * borFor(sorted.upperShadowCount, r.upperShadowCount, -1) +
      WCMI_CONFIG.W_LOWER_SHADOW * borFor(sorted.lowerShadowCount, r.lowerShadowCount, +1) +
      WCMI_CONFIG.W_CONTINUITY * borFor(sorted.continuityMatchRate, r.continuityMatchRate, +1) +
      WCMI_CONFIG.W_GREEN_RATE * borFor(sorted.greenRate, r.greenRate, +1) +
      WCMI_CONFIG.W_DRAWDOWN * borFor(sorted.maxDrawdown, r.maxDrawdown, -1) +
      WCMI_CONFIG.W_BIG_DOWN * borFor(sorted.bigDownCount, r.bigDownCount, -1) +
      WCMI_CONFIG.W_LOW_OPEN * borFor(sorted.lowOpenCount, r.lowOpenCount, -1);
    moduleSums.set(it.code, {
      sMom,
      sExp,
      sTiming: r.sTimingAbsolute,
      pFomo: r.pFomoAbsolute,
    });
  }

  // ── Phase B.4: rank the four module sums over survivors
  const moduleSorted = {
    sMom: sortedFromMap(moduleSums, (m) => m.sMom),
    sExp: sortedFromMap(moduleSums, (m) => m.sExp),
    sTiming: sortedFromMap(moduleSums, (m) => m.sTiming),
    pFomo: sortedFromMap(moduleSums, (m) => m.pFomo),
  };

  // ── Phase B.5: compose final ∈ [-WCMI_TOTAL_SCALE, +WCMI_TOTAL_SCALE]
  // Scale each module's `[-1, +1]` percentile-norm by its share of
  // the total: `weight / Σ_positive(weights) · TOTAL_SCALE`. P_fomo
  // is subtracted; a worst-case fomo on a code that's also bottom
  // across all positive modules can overshoot −TOTAL_SCALE, hence the
  // symmetric clip at the end.
  const positiveSum =
    WCMI_CONFIG.W_FINAL_MOM + WCMI_CONFIG.W_FINAL_EXP + WCMI_CONFIG.W_FINAL_TIMING;
  const unit = WCMI_CONFIG.WCMI_TOTAL_SCALE / positiveSum;
  for (const it of survivors) {
    const m = moduleSums.get(it.code)!;
    const blended =
      WCMI_CONFIG.W_FINAL_MOM * normFromSorted(moduleSorted.sMom, m.sMom) +
      WCMI_CONFIG.W_FINAL_EXP * normFromSorted(moduleSorted.sExp, m.sExp) +
      WCMI_CONFIG.W_FINAL_TIMING * normFromSorted(moduleSorted.sTiming, m.sTiming) -
      WCMI_CONFIG.W_FINAL_FOMO * normFromSorted(moduleSorted.pFomo, m.pFomo);
    const scaled = clip(
      blended * unit,
      -WCMI_CONFIG.WCMI_TOTAL_SCALE,
      WCMI_CONFIG.WCMI_TOTAL_SCALE,
    );
    out.set(it.code, Number.isFinite(scaled) ? scaled : null);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────
// Bor + percentile helpers
// ─────────────────────────────────────────────────────────────────

/** Step function on rank-from-top (0 = best). */
function bor(rankFromTop: number): number {
  if (rankFromTop < 0.01) return 20;
  if (rankFromTop < 0.05) return 15;
  if (rankFromTop < 0.1) return 10;
  if (rankFromTop < 0.2) return 5;
  if (rankFromTop < 0.3) return 0;
  if (rankFromTop < 0.4) return -5;
  if (rankFromTop < 0.5) return -10;
  return -20;
}

/** bor over a feature value; `direction = +1` means higher is better. */
function borFor(sorted: readonly number[], v: number | null, direction: 1 | -1): number {
  if (v === null) return -20; // missing data = bottom bucket
  const p = percentile(sorted, v);
  const rankFromTop = direction === 1 ? 1 - p : p;
  return bor(rankFromTop);
}

/** Average-rank percentile: `(low_count + 0.5·equal_count) / N`. */
function percentile(sorted: readonly number[], v: number): number {
  const N = sorted.length;
  if (N === 0) return 0.5;
  const firstGe = lowerBound(sorted, v);
  const firstGt = upperBound(sorted, v, firstGe);
  const lowCount = firstGe;
  const equalCount = firstGt - firstGe;
  return (lowCount + 0.5 * equalCount) / N;
}

/** First index with `arr[i] >= v` (binary search). */
function lowerBound(arr: readonly number[], v: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index with `arr[i] > v`, starting search at `from`. */
function upperBound(arr: readonly number[], v: number, from: number): number {
  let lo = from;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid]! <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function normFromSorted(sorted: readonly number[], v: number): number {
  return clip(2 * percentile(sorted, v) - 1, -1, 1);
}

interface SortedTables {
  readonly r5: readonly number[];
  readonly r10: readonly number[];
  readonly r20: readonly number[];
  readonly r60: readonly number[];
  readonly r90: readonly number[];
  readonly kformUpCount: readonly number[];
  readonly kformDnCount: readonly number[];
  readonly upperShadowCount: readonly number[];
  readonly lowerShadowCount: readonly number[];
  readonly continuityMatchRate: readonly number[];
  readonly greenRate: readonly number[];
  readonly maxDrawdown: readonly number[];
  readonly bigDownCount: readonly number[];
  readonly lowOpenCount: readonly number[];
}

function buildRankTables(survivors: readonly ScoringInput[]): SortedTables {
  return {
    r5: sortedFromItems(survivors, (s) => s.raw.r5),
    r10: sortedFromItems(survivors, (s) => s.raw.r10),
    r20: sortedFromItems(survivors, (s) => s.raw.r20),
    r60: sortedFromItems(survivors, (s) => s.raw.r60),
    r90: sortedFromItems(survivors, (s) => s.raw.r90),
    kformUpCount: sortedFromItems(survivors, (s) => s.raw.kformUpCount),
    kformDnCount: sortedFromItems(survivors, (s) => s.raw.kformDnCount),
    upperShadowCount: sortedFromItems(survivors, (s) => s.raw.upperShadowCount),
    lowerShadowCount: sortedFromItems(survivors, (s) => s.raw.lowerShadowCount),
    continuityMatchRate: sortedFromItems(survivors, (s) => s.raw.continuityMatchRate),
    greenRate: sortedFromItems(survivors, (s) => s.raw.greenRate),
    maxDrawdown: sortedFromItems(survivors, (s) => s.raw.maxDrawdown),
    bigDownCount: sortedFromItems(survivors, (s) => s.raw.bigDownCount),
    lowOpenCount: sortedFromItems(survivors, (s) => s.raw.lowOpenCount),
  };
}

function sortedFromItems(
  items: readonly ScoringInput[],
  pick: (s: ScoringInput) => number | null,
): readonly number[] {
  const out: number[] = [];
  for (const it of items) {
    const v = pick(it);
    if (v === null) continue;
    if (!Number.isFinite(v)) continue;
    out.push(v);
  }
  out.sort((a, b) => a - b);
  return out;
}

function sortedFromMap<V>(map: ReadonlyMap<string, V>, pick: (v: V) => number): readonly number[] {
  const out: number[] = [];
  for (const v of map.values()) {
    const x = pick(v);
    if (Number.isFinite(x)) out.push(x);
  }
  out.sort((a, b) => a - b);
  return out;
}

// ─────────────────────────────────────────────────────────────────
// Per-code raw extractors
// ─────────────────────────────────────────────────────────────────

function buildBarMetrics(bars: readonly BarLike[]): readonly (BarMetrics | null)[] {
  const out: (BarMetrics | null)[] = new Array(bars.length);
  for (let i = 0; i < bars.length; i += 1) {
    if (i === 0) {
      out[i] = null;
      continue;
    }
    out[i] = computeBarMetrics(bars[i - 1]!, bars[i]!);
  }
  return out;
}

function computeBarMetrics(prev: BarLike, cur: BarLike): BarMetrics | null {
  const prevClose = prev.close_qfq;
  if (prevClose <= 0) return null;
  const change = ((cur.close_qfq - prevClose) / prevClose) * 100;
  const gap = ((cur.open_qfq - prevClose) / prevClose) * 100;
  const bodyTop = Math.max(cur.open_qfq, cur.close_qfq);
  const bodyBottom = Math.min(cur.open_qfq, cur.close_qfq);
  // User-defined: upper = H − O, lower = C − L (asymmetric reference
  // points; see BarMetrics docstring).
  const upperShadow = Math.max(((cur.high_qfq - cur.open_qfq) / prevClose) * 100, 0);
  const lowerShadow = Math.max(((cur.close_qfq - cur.low_qfq) / prevClose) * 100, 0);
  // Traditional wicks — kept for kform detection (close-at-high /
  // close-at-low semantics).
  const wickAboveBodyTop = Math.max(((cur.high_qfq - bodyTop) / prevClose) * 100, 0);
  const wickBelowBodyBottom = Math.max(((bodyBottom - cur.low_qfq) / prevClose) * 100, 0);
  const amplitude = Math.max(((cur.high_qfq - cur.low_qfq) / prevClose) * 100, 0);
  return {
    change,
    gap,
    upperShadow,
    lowerShadow,
    wickAboveBodyTop,
    wickBelowBodyBottom,
    amplitude,
    closeAboveOpen: cur.close_qfq > cur.open_qfq,
  };
}

function movingAverage(closes: readonly number[], window: number): readonly (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (window <= 0 || closes.length < window) return out;
  let sum = 0;
  for (let i = 0; i < window; i += 1) sum += closes[i]!;
  out[window - 1] = sum / window;
  for (let i = window; i < closes.length; i += 1) {
    sum += closes[i]! - closes[i - window]!;
    out[i] = sum / window;
  }
  return out;
}

function computeRet(bars: readonly BarLike[], T: number): number | null {
  if (bars.length <= T) return null;
  const base = bars[bars.length - 1 - T]!.close_qfq;
  if (base <= 0) return null;
  const latest = bars[bars.length - 1]!.close_qfq;
  return ((latest - base) / base) * 100;
}

interface FormCounts {
  readonly kformUpCount: number;
  readonly kformDnCount: number;
  readonly upperShadowCount: number;
  readonly lowerShadowCount: number;
  readonly bigDownCount: number;
  readonly lowOpenCount: number;
}

function countKlineForms(tail: readonly (BarMetrics | null)[]): FormCounts {
  let kformUpCount = 0;
  let kformDnCount = 0;
  let upperShadowCount = 0;
  let lowerShadowCount = 0;
  let bigDownCount = 0;
  let lowOpenCount = 0;
  for (const m of tail) {
    if (m === null) continue;
    // kform_up / kform_dn use the *traditional* body-anchored wicks so
    // "光头大阳 / 光脚大阴" keeps its "closed at the day's high / low"
    // semantics regardless of the user's new H−O / C−L shadow change.
    if (m.change > WCMI_CONFIG.BIG_MOVE && m.wickAboveBodyTop < WCMI_CONFIG.SHAVED_SHADOW) {
      kformUpCount += 1;
    }
    if (m.change < -WCMI_CONFIG.BIG_MOVE && m.wickBelowBodyBottom < WCMI_CONFIG.SHAVED_SHADOW) {
      kformDnCount += 1;
    }
    // Long-shadow counts use the new asymmetric shadow definitions
    // (upper = H−O, lower = C−L).
    if (m.upperShadow > WCMI_CONFIG.LONG_SHADOW) upperShadowCount += 1;
    if (m.lowerShadow > WCMI_CONFIG.LONG_SHADOW) lowerShadowCount += 1;
    // Big-down only — bigMoveCount removed (was symmetric and double-
    // counted with kform_dn on the down side). Up-side jumpiness is
    // already partly captured by long-upper-shadow + last-day anomaly.
    if (m.change < -WCMI_CONFIG.BIG_DOWN_THR) bigDownCount += 1;
    // "低开但拉回不算" — a gap-down that recovers above the open
    // intraday is a buying-the-dip signal, not a holding-pain signal.
    if (m.gap < WCMI_CONFIG.LOW_OPEN_GAP_THR && !m.closeAboveOpen) {
      lowOpenCount += 1;
    }
  }
  return {
    kformUpCount,
    kformDnCount,
    upperShadowCount,
    lowerShadowCount,
    bigDownCount,
    lowOpenCount,
  };
}

function computeContinuityMatchRate(tail: readonly (BarMetrics | null)[]): number {
  const W = WCMI_CONFIG.CONT_WINDOW;
  if (tail.length < W) return 0;
  let matches = 0;
  let total = 0;
  for (let i = 0; i <= tail.length - W; i += 1) {
    let greens = 0;
    let cum = 0;
    let bad = false;
    for (let j = i; j < i + W; j += 1) {
      const m = tail[j] ?? null;
      if (m === null) {
        bad = true;
        break;
      }
      if (m.change > 0) greens += 1;
      cum += m.change;
    }
    if (bad) continue;
    total += 1;
    if (greens >= WCMI_CONFIG.CONT_MIN_UP && cum > 0) matches += 1;
  }
  if (total === 0) return 0;
  return matches / total;
}

function computeGreenRate(tail: readonly (BarMetrics | null)[]): number {
  let up = 0;
  let total = 0;
  for (const m of tail) {
    if (m === null) continue;
    total += 1;
    if (m.change > 0) up += 1;
  }
  if (total === 0) return 0;
  return up / total;
}

function computeMaxDrawdown(bars: readonly BarLike[], lookback: number): number {
  const tail = bars.slice(bars.length - Math.min(lookback, bars.length));
  let peak = -Infinity;
  let maxDd = 0;
  for (const b of tail) {
    if (b.close_qfq > peak) peak = b.close_qfq;
    if (peak <= 0) continue;
    const dd = ((peak - b.close_qfq) / peak) * 100;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

// ─────────────────────────────────────────────────────────────────
// S_timing — absolute scoring helpers (unchanged from previous spec)
// ─────────────────────────────────────────────────────────────────

function proximityMax(
  close: number,
  ma5: number | null,
  ma10: number | null,
  ma20: number | null,
): number {
  return Math.max(
    proximityReward(close, ma10, WCMI_CONFIG.MA_10_BASE),
    proximityReward(close, ma5, WCMI_CONFIG.MA_5_BASE),
    proximityReward(close, ma20, WCMI_CONFIG.MA_20_BASE),
    0,
  );
}

function proximityReward(close: number, ma: number | null, base: number): number {
  if (ma === null || ma <= 0) return 0;
  const bias = (Math.abs(close - ma) / ma) * 100;
  return base * Math.max(0, 1 - bias / WCMI_CONFIG.MA_NEAR_RANGE);
}

function accumulateMaSupport(
  bars: readonly BarLike[],
  bm: readonly (BarMetrics | null)[],
  ma5: readonly (number | null)[],
  ma10: readonly (number | null)[],
  ma20: readonly (number | null)[],
  lookbackBars: number,
): number {
  const tailFrom = bars.length - Math.min(lookbackBars, bars.length);
  let total = 0;
  for (let i = tailFrom; i < bars.length; i += 1) {
    if (i === 0) continue;
    const cur = bars[i]!;
    const prev = bars[i - 1]!;
    const m = bm[i] ?? null;
    const ma5i = ma5[i] ?? null;
    const ma10i = ma10[i] ?? null;
    const ma20i = ma20[i] ?? null;
    if (ma10i !== null) {
      if (cur.low_qfq <= ma10i && cur.close_qfq > ma10i) total += WCMI_CONFIG.MA10_TOUCH_REWARD;
      if (
        m !== null &&
        prev.close_qfq > ma10i &&
        cur.close_qfq < ma10i &&
        m.change < WCMI_CONFIG.MA10_BREAK_THR
      )
        total -= WCMI_CONFIG.MA10_BREAK_PEN;
    }
    if (ma5i !== null) {
      if (cur.low_qfq <= ma5i && cur.close_qfq > ma5i) total += WCMI_CONFIG.MA5_TOUCH_REWARD;
      if (
        m !== null &&
        prev.close_qfq > ma5i &&
        cur.close_qfq < ma5i &&
        m.change < WCMI_CONFIG.MA5_BREAK_THR
      )
        total -= WCMI_CONFIG.MA5_BREAK_PEN;
    }
    if (ma20i !== null) {
      if (cur.low_qfq <= ma20i && cur.close_qfq > ma20i) total += WCMI_CONFIG.MA20_TOUCH_REWARD;
    }
  }
  return total;
}

function lastDayAnomalyPenalty(latest: BarMetrics): number {
  const exChg = Math.max(0, Math.abs(latest.change) - WCMI_CONFIG.LAST_DAY_THR);
  const exAmp = Math.max(0, latest.amplitude - WCMI_CONFIG.LAST_DAY_THR);
  if (exChg === 0 && exAmp === 0) return 0;
  return -(
    Math.pow(exChg, WCMI_CONFIG.LAST_P) * WCMI_CONFIG.LAST_CHANGE_K +
    Math.pow(exAmp, WCMI_CONFIG.LAST_P) * WCMI_CONFIG.LAST_AMP_K
  );
}

// ─────────────────────────────────────────────────────────────────
// P_fomo — absolute scoring helpers
// ─────────────────────────────────────────────────────────────────

function overboughtPenalty(close: number, ma5: number | null, ma10: number | null): number {
  let pen = 0;
  if (ma5 !== null && ma5 > 0) {
    const bias5 = ((close - ma5) / ma5) * 100;
    if (bias5 > WCMI_CONFIG.BIAS5_OB) {
      pen += Math.pow(bias5 - WCMI_CONFIG.BIAS5_OB, WCMI_CONFIG.OB_P) * WCMI_CONFIG.OB_BIAS5_K;
    }
  }
  if (ma10 !== null && ma10 > 0) {
    const bias10 = ((close - ma10) / ma10) * 100;
    if (bias10 > WCMI_CONFIG.BIAS10_OB) {
      pen += Math.pow(bias10 - WCMI_CONFIG.BIAS10_OB, WCMI_CONFIG.OB_P) * WCMI_CONFIG.OB_BIAS10_K;
    }
  }
  return pen;
}

function lowTurnoverFomoPenalty(bars: readonly BarLike[], r5: number | null): number {
  if (r5 === null || r5 <= WCMI_CONFIG.FOMO_R5_THR) return 0;
  if (bars.length < WCMI_CONFIG.FOMO_AVG_WINDOW) return 0;
  const avg5 = avgTurnover(bars.slice(-5));
  const avgN = avgTurnover(bars.slice(-WCMI_CONFIG.FOMO_AVG_WINDOW));
  if (avgN <= 0) return 0;
  if (avg5 < avgN * WCMI_CONFIG.FOMO_TURNOVER_RATIO) return WCMI_CONFIG.FOMO_LOW_TURNOVER_PEN;
  return 0;
}

function avgTurnover(bars: readonly BarLike[]): number {
  if (bars.length === 0) return 0;
  let s = 0;
  for (const b of bars) s += b.turnover;
  return s / bars.length;
}

function isLimitUpSealed(bars: readonly BarLike[], latestM: BarMetrics): boolean {
  const last = bars[bars.length - 1];
  if (last === undefined) return false;
  return (
    last.high_qfq === last.low_qfq &&
    latestM.change > WCMI_CONFIG.LIMIT_UP_CHG &&
    latestM.amplitude < WCMI_CONFIG.LIMIT_UP_AMP_MAX
  );
}

// ─────────────────────────────────────────────────────────────────
// Misc utilities
// ─────────────────────────────────────────────────────────────────

function clip(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
