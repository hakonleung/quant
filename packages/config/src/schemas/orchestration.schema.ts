/**
 * Update orchestration queues + cron.
 *
 * Hardcoded curves — these were tuned empirically (see
 * docs/modules/09-update-orchestration.md) and don't need env knobs.
 */

export interface BackoffConfig {
  readonly baseMs: number;
  readonly factor: number;
  readonly maxMs: number;
  readonly jitterRatio: number;
}

export interface QueueConfig {
  readonly concurrency: number;
  readonly maxRetry: number;
  readonly taskBackoff: BackoffConfig;
  readonly poolBackoff: BackoffConfig;
}

export interface CronConfig {
  readonly bjtHour: number;
  readonly bjtMinute: number;
  readonly bjtOffsetMs: number;
  readonly dayMs: number;
}

export interface OrchestrationConfig {
  readonly queues: {
    readonly meta: QueueConfig;
    readonly kline: QueueConfig;
  };
  readonly cron: CronConfig;
}

const POOL_DEFAULT: BackoffConfig = {
  baseMs: 5_000,
  factor: 2,
  maxMs: 5 * 60_000,
  jitterRatio: 0.2,
};

export const DEFAULT_ORCHESTRATION_CONFIG: OrchestrationConfig = {
  queues: {
    meta: {
      concurrency: 8,
      maxRetry: 3,
      taskBackoff: { baseMs: 1_000, factor: 2, maxMs: 5 * 60_000, jitterRatio: 0.2 },
      poolBackoff: POOL_DEFAULT,
    },
    kline: {
      concurrency: 8,
      maxRetry: 3,
      taskBackoff: { baseMs: 5_000, factor: 2, maxMs: 15 * 60_000, jitterRatio: 0.2 },
      poolBackoff: POOL_DEFAULT,
    },
  },
  cron: {
    bjtHour: 16,
    bjtMinute: 0,
    bjtOffsetMs: 8 * 60 * 60_000,
    dayMs: 24 * 60 * 60_000,
  },
};

export interface OrchestrationConfigOverrides {
  readonly queues?: {
    readonly meta?: QueueConfig;
    readonly kline?: QueueConfig;
  };
  readonly cron?: Partial<CronConfig>;
}

export function orchestrationConfig(
  overrides: OrchestrationConfigOverrides = {},
): OrchestrationConfig {
  return {
    queues: { ...DEFAULT_ORCHESTRATION_CONFIG.queues, ...(overrides.queues ?? {}) },
    cron: { ...DEFAULT_ORCHESTRATION_CONFIG.cron, ...(overrides.cron ?? {}) },
  };
}
