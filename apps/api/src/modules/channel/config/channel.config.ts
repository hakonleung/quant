/**
 * Channel module env configuration.
 *
 * Strict zod schema (CLAUDE.md §1.2 — all external inputs validated at
 * the boundary). Reading happens once at module init; if the user
 * enables a channel without providing its credentials, we fail fast
 * with a clear message rather than silently dry-running forever.
 */

import { ChannelIdSchema, type ChannelId } from '@quant/shared';
import { z } from 'zod';

const RawSchema = z.object({
  CHANNEL_ENABLED: z.string().default(''),
  CHANNEL_DRY_RUN: z
    .union([z.literal('1'), z.literal('true'), z.literal('0'), z.literal('false'), z.literal('')])
    .default(''),
  CHANNEL_REDIS_URL: z.string().min(1).default('redis://127.0.0.1:6379'),
  CHANNEL_BULL_PREFIX: z.string().min(1).default('quant:channel'),

  CHANNEL_SLACK_BOT_TOKEN: z.string().min(1).optional(),
  CHANNEL_SLACK_APP_TOKEN: z.string().min(1).optional(),
  CHANNEL_SLACK_DEFAULT_CHANNEL: z.string().min(1).optional(),

  CHANNEL_FEISHU_APP_ID: z.string().min(1).optional(),
  CHANNEL_FEISHU_APP_SECRET: z.string().min(1).optional(),
  CHANNEL_FEISHU_DEFAULT_CHAT_ID: z.string().min(1).optional(),
  // Optional — only required if the Feishu app has Encrypt Key /
  // Verification Token configured for the Card Request URL callback.
  // See `docs/integrations/auth.md` and the Feishu console under
  // 事件与回调 → 加密策略.
  CHANNEL_FEISHU_ENCRYPT_KEY: z.string().min(1).optional(),
  CHANNEL_FEISHU_VERIFICATION_TOKEN: z.string().min(1).optional(),
});

export interface SlackConfig {
  readonly botToken: string;
  /** Required for Socket Mode (inbound). When absent, only outbound works. */
  readonly appToken: string | null;
  readonly defaultChannel: string;
}

export interface FeishuConfig {
  readonly appId: string;
  readonly appSecret: string;
  readonly defaultChatId: string;
  /** AES key for encrypted callbacks; null when the app uses plain payloads. */
  readonly encryptKey: string | null;
  /** Verification token used by the SHA1 signature on schema-1 card callbacks. */
  readonly verificationToken: string | null;
}

export interface ChannelConfig {
  readonly enabled: ReadonlySet<ChannelId>;
  /** Force dry-run mode regardless of which channels enable. */
  readonly dryRun: boolean;
  readonly redisUrl: string;
  readonly bullPrefix: string;
  readonly slack: SlackConfig | null;
  readonly feishu: FeishuConfig | null;
}

function parseEnabled(raw: string): ReadonlySet<ChannelId> {
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const out = new Set<ChannelId>();
  for (const id of ids) {
    const parsed = ChannelIdSchema.safeParse(id);
    if (parsed.success) out.add(parsed.data);
  }
  return out;
}

export function loadChannelConfig(env: NodeJS.ProcessEnv = process.env): ChannelConfig {
  const raw = RawSchema.parse({
    CHANNEL_ENABLED: env['CHANNEL_ENABLED'] ?? '',
    CHANNEL_DRY_RUN: env['CHANNEL_DRY_RUN'] ?? '',
    CHANNEL_REDIS_URL: env['CHANNEL_REDIS_URL'] ?? 'redis://127.0.0.1:6379',
    CHANNEL_BULL_PREFIX: env['CHANNEL_BULL_PREFIX'] ?? 'quant:channel',
    CHANNEL_SLACK_BOT_TOKEN: env['CHANNEL_SLACK_BOT_TOKEN'],
    CHANNEL_SLACK_APP_TOKEN: env['CHANNEL_SLACK_APP_TOKEN'],
    CHANNEL_SLACK_DEFAULT_CHANNEL: env['CHANNEL_SLACK_DEFAULT_CHANNEL'],
    CHANNEL_FEISHU_APP_ID: env['CHANNEL_FEISHU_APP_ID'],
    CHANNEL_FEISHU_APP_SECRET: env['CHANNEL_FEISHU_APP_SECRET'],
    CHANNEL_FEISHU_DEFAULT_CHAT_ID: env['CHANNEL_FEISHU_DEFAULT_CHAT_ID'],
    CHANNEL_FEISHU_ENCRYPT_KEY: env['CHANNEL_FEISHU_ENCRYPT_KEY'],
    CHANNEL_FEISHU_VERIFICATION_TOKEN: env['CHANNEL_FEISHU_VERIFICATION_TOKEN'],
  });
  const enabled = parseEnabled(raw.CHANNEL_ENABLED);
  const dryRun = raw.CHANNEL_DRY_RUN === '1' || raw.CHANNEL_DRY_RUN === 'true';

  let slack: SlackConfig | null = null;
  if (enabled.has('slack')) {
    if (raw.CHANNEL_SLACK_BOT_TOKEN === undefined) {
      throw new Error('channel:slack enabled but CHANNEL_SLACK_BOT_TOKEN is missing');
    }
    slack = {
      botToken: raw.CHANNEL_SLACK_BOT_TOKEN,
      appToken: raw.CHANNEL_SLACK_APP_TOKEN ?? null,
      defaultChannel: raw.CHANNEL_SLACK_DEFAULT_CHANNEL ?? '#quant-signals',
    };
  }

  let feishu: FeishuConfig | null = null;
  if (enabled.has('feishu')) {
    if (raw.CHANNEL_FEISHU_APP_ID === undefined || raw.CHANNEL_FEISHU_APP_SECRET === undefined) {
      throw new Error('channel:feishu enabled but CHANNEL_FEISHU_APP_ID/SECRET is missing');
    }
    feishu = {
      appId: raw.CHANNEL_FEISHU_APP_ID,
      appSecret: raw.CHANNEL_FEISHU_APP_SECRET,
      defaultChatId: raw.CHANNEL_FEISHU_DEFAULT_CHAT_ID ?? '',
      encryptKey: raw.CHANNEL_FEISHU_ENCRYPT_KEY ?? null,
      verificationToken: raw.CHANNEL_FEISHU_VERIFICATION_TOKEN ?? null,
    };
  }

  return {
    enabled,
    dryRun,
    redisUrl: raw.CHANNEL_REDIS_URL,
    bullPrefix: raw.CHANNEL_BULL_PREFIX,
    slack,
    feishu,
  };
}

export const CHANNEL_CONFIG = Symbol('CHANNEL_CONFIG');
