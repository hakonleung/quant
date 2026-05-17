/**
 * Channel module (IM bus) shape.
 *
 * Env-agnostic — the caller resolves `CHANNEL_*` env keys, verifies
 * required-secret invariants, and passes the typed shape via
 * {@link channelConfig}. Bus retry curve is hardcoded.
 */

import type { ChannelId } from '@quant/shared';

export interface SlackConfig {
  readonly botToken: string;
  readonly appToken: string | null;
  readonly defaultChannel: string;
}

export interface FeishuConfig {
  readonly appId: string;
  readonly appSecret: string;
  readonly defaultChatId: string;
  readonly encryptKey: string | null;
  readonly verificationToken: string | null;
}

export interface ChannelBusConfig {
  readonly attempts: number;
  readonly backoffDelayMs: number;
  readonly removeOnComplete: number;
  readonly removeOnFail: number;
}

export interface ChannelConfig {
  readonly enabled: ReadonlySet<ChannelId>;
  readonly dryRun: boolean;
  readonly redisUrl: string;
  readonly bullPrefix: string;
  readonly slack: SlackConfig | null;
  readonly feishu: FeishuConfig | null;
  readonly bus: ChannelBusConfig;
}

export const DEFAULT_CHANNEL_BUS_CONFIG: ChannelBusConfig = {
  attempts: 5,
  backoffDelayMs: 2_000,
  removeOnComplete: 100,
  removeOnFail: 200,
};

export const DEFAULT_CHANNEL_CONFIG: ChannelConfig = {
  enabled: new Set<ChannelId>(),
  dryRun: false,
  redisUrl: 'redis://127.0.0.1:6379',
  bullPrefix: 'quant:channel',
  slack: null,
  feishu: null,
  bus: DEFAULT_CHANNEL_BUS_CONFIG,
};

export interface ChannelConfigOverrides {
  readonly enabled?: ReadonlySet<ChannelId>;
  readonly dryRun?: boolean;
  readonly redisUrl?: string;
  readonly bullPrefix?: string;
  readonly slack?: SlackConfig | null;
  readonly feishu?: FeishuConfig | null;
  readonly bus?: Partial<ChannelBusConfig>;
}

export function channelConfig(overrides: ChannelConfigOverrides = {}): ChannelConfig {
  return {
    ...DEFAULT_CHANNEL_CONFIG,
    ...overrides,
    bus: { ...DEFAULT_CHANNEL_BUS_CONFIG, ...(overrides.bus ?? {}) },
  };
}
