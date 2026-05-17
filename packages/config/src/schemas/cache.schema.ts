/**
 * Cache layer tuning. Redis URL/prefix is env-driven (callers parse
 * `CACHE_REDIS_*` and pass values); TTLs / sweep cadences are hardcoded.
 */

export interface RedisCacheConfig {
  readonly url: string;
  readonly keyPrefix: string;
  readonly maxRetriesPerRequest: number;
}

export interface SentimentCacheConfig {
  readonly ttlMs: number;
}

export interface AgentPendingCacheConfig {
  readonly defaultTtlMs: number;
  readonly sweepIntervalMs: number;
}

export interface CacheConfig {
  readonly redis: RedisCacheConfig;
  readonly sentiment: SentimentCacheConfig;
  readonly agentPending: AgentPendingCacheConfig;
}

export const DEFAULT_REDIS_CACHE_CONFIG: RedisCacheConfig = {
  url: 'redis://127.0.0.1:6379/1',
  keyPrefix: 'quant:cache:',
  maxRetriesPerRequest: 1,
};

export const DEFAULT_CACHE_CONFIG: CacheConfig = {
  redis: DEFAULT_REDIS_CACHE_CONFIG,
  sentiment: { ttlMs: 30 * 24 * 60 * 60 * 1000 },
  agentPending: { defaultTtlMs: 5 * 60 * 1000, sweepIntervalMs: 30 * 1000 },
};

export interface CacheConfigOverrides {
  readonly redis?: Partial<RedisCacheConfig>;
  readonly sentiment?: Partial<SentimentCacheConfig>;
  readonly agentPending?: Partial<AgentPendingCacheConfig>;
}

export function cacheConfig(overrides: CacheConfigOverrides = {}): CacheConfig {
  return {
    redis: { ...DEFAULT_REDIS_CACHE_CONFIG, ...(overrides.redis ?? {}) },
    sentiment: { ...DEFAULT_CACHE_CONFIG.sentiment, ...(overrides.sentiment ?? {}) },
    agentPending: { ...DEFAULT_CACHE_CONFIG.agentPending, ...(overrides.agentPending ?? {}) },
  };
}
