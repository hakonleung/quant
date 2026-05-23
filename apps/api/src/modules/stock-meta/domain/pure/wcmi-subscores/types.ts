/**
 * WCMI v2（90 日波动质量）评分引擎的类型定义。
 *
 * 设计文档：`docs/perf/wcmi-redesign.md`。
 *
 * 注意：所有可调常量的 **值** 与 **详细说明** 维护在 `./config.ts` 的
 * `WCMI_CONFIG` 中。本文件只声明字段类型，避免接口注释与值注释两处漂移。
 */

export interface WcmiConfig {
  // 采样窗口
  readonly WINDOW: number;
  readonly MIN_BARS: number;

  // 子分 1: rhythm（节奏）
  readonly RHYTHM_TARGET: number;
  readonly SWING_PERIOD_BARS: number;
  readonly RHYTHM_AUTOCORR_SCALE: number;
  readonly RHYTHM_SWING_DENSITY_CAP: number;
  readonly RHYTHM_W_AUTOCORR: number;
  readonly RHYTHM_W_SWING: number;

  // 子分 2: ma_support（均线支撑）
  readonly MA20_DIST_CAP: number;
  readonly MA_W_ABOVE_MA20: number;
  readonly MA_W_ABOVE_MA60: number;
  readonly MA_W_ALIGNMENT: number;
  readonly MA_W_MEAN_DIST: number;

  // 子分 3: up_wave_smoothness（上行波平滑度）
  readonly MAX_YANG_RUN_CAP: number;
  readonly MEAN_YANG_RUN_CAP: number;
  readonly MEAN_SWING_DD_CAP: number;
  readonly DEFAULT_SLOPE_R2: number;
  readonly MIN_SEGMENT_BARS: number;
  readonly UP_WAVE_W_MAX_YANG: number;
  readonly UP_WAVE_W_MEAN_YANG: number;
  readonly UP_WAVE_W_SWING_DD: number;
  readonly UP_WAVE_W_SLOPE_R2: number;

  // 子分 5: upper_shadow_clean（上影线"干净度"）
  readonly SHADOW_BODY_THR: number;
  readonly SHADOW_RANGE_THR: number;
  readonly SHADOW_MIN_DIVISOR_PCT: number;
  readonly SHADOW_W_BODY: number;
  readonly SHADOW_W_RANGE: number;
  readonly SHADOW_YANG_WEIGHT: number;
  readonly SHADOW_YIN_WEIGHT: number;

  // 子分 6: stage_gain（区间涨幅）
  readonly STAGE_RECENCY_BIAS: number;
  readonly STAGE_W_R_WINDOW: number;
  readonly STAGE_W_RANGE_GAIN: number;

  // 子分 7: crash_avoidance（防崩盘）
  readonly CRASH_DAY_THR: number;
  readonly CRASH_COUNT_CAP: number;
  readonly GAP_DOWN_THR: number;
  readonly GAP_DOWN_CAP: number;
  readonly CRASH_SEVERITY_SPAN_PCT: number;
  readonly CRASH_W_COUNT: number;
  readonly CRASH_W_SEVERITY: number;
  readonly CRASH_W_GAP_DOWN: number;

  // 子分 8: recent_strength（近端强度 + 连阴 + 回撤）
  readonly RECENT_WINDOW: number;
  readonly RECENT_YIN_RUN_CAP: number;
  readonly RECENT_PULLBACK_CAP: number;
  readonly RECENT_RET_SCALE: number;
  readonly RECENT_W_RET: number;
  readonly RECENT_W_YIN_RUN: number;
  readonly RECENT_W_PULLBACK: number;

  // 组合权重 & 输出标度
  readonly W_RHYTHM: number;
  readonly W_MA_SUPPORT: number;
  readonly W_UP_WAVE: number;
  readonly W_YANG_DOM: number;
  readonly W_SHADOW_CLEAN: number;
  readonly W_STAGE_GAIN: number;
  readonly W_CRASH_AVOID: number;
  readonly W_RECENT_STRENGTH: number;
  readonly WCMI_TOTAL_SCALE: number;
}

export interface WcmiSubscores {
  readonly rhythm: number;
  readonly maSupport: number;
  readonly upWaveSmoothness: number;
  readonly yangDominance: number;
  readonly upperShadowClean: number;
  readonly stageGain: number;
  readonly crashAvoidance: number;
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
