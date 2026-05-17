/**
 * NestJS bootstrap-time env → ConfigCenter seed.
 *
 * The ONLY place in the NestJS process that reads `process.env`. Every
 * downstream consumer reads through `ServerConfigCenter`. Trusts the
 * env file — no defensive validation.
 *
 * Only overrides fields that env actually provides; the rest are
 * supplied by the per-domain `DEFAULT_*_CONFIG` constants inside
 * `@quant/config`. A literal default appearing here would be drift
 * waiting to happen.
 */

import { ServerConfigCenter } from '@quant/config/server';
import type { ChannelId } from '@quant/shared';

export function bootstrapConfigCenter(): ServerConfigCenter {
  const e = process.env;
  const csv = (raw: string | undefined): string[] =>
    (raw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

  const enabled = new Set(csv(e['CHANNEL_ENABLED']) as ChannelId[]);
  const truthy = (v: string | undefined): boolean => v === 'true' || v === '1';

  return ServerConfigCenter.init(
    {
      auth: {
        ...(e['AUTH_MODE'] === 'oauth' && { mode: 'oauth' }),
        ...(e['NEXTAUTH_SECRET'] && { nextauthSecret: e['NEXTAUTH_SECRET'] }),
        ...(e['NEXTAUTH_URL'] && { nextauthUrl: e['NEXTAUTH_URL'] }),
        ...(e['QUANT_DATA_ROOT'] && { dataRoot: e['QUANT_DATA_ROOT'] }),
        ...(e['AUTH_ADMIN_USER_IDS'] && {
          adminUserIds: new Set(csv(e['AUTH_ADMIN_USER_IDS'])),
        }),
      },
      cache: {
        redis: {
          ...(e['CACHE_REDIS_URL'] && { url: e['CACHE_REDIS_URL'] }),
          ...(e['CACHE_REDIS_KEY_PREFIX'] && { keyPrefix: e['CACHE_REDIS_KEY_PREFIX'] }),
        },
      },
      channel: {
        ...(e['CHANNEL_ENABLED'] && { enabled }),
        ...(e['CHANNEL_DRY_RUN'] && { dryRun: truthy(e['CHANNEL_DRY_RUN']) }),
        ...(e['CHANNEL_REDIS_URL'] && { redisUrl: e['CHANNEL_REDIS_URL'] }),
        ...(e['CHANNEL_BULL_PREFIX'] && { bullPrefix: e['CHANNEL_BULL_PREFIX'] }),
        ...(enabled.has('slack') && {
          slack: {
            botToken: e['CHANNEL_SLACK_BOT_TOKEN'] ?? '',
            appToken: e['CHANNEL_SLACK_APP_TOKEN'] ?? null,
            defaultChannel: e['CHANNEL_SLACK_DEFAULT_CHANNEL'] ?? '#quant-signals',
          },
        }),
        ...(enabled.has('feishu') && {
          feishu: {
            appId: e['CHANNEL_FEISHU_APP_ID'] ?? '',
            appSecret: e['CHANNEL_FEISHU_APP_SECRET'] ?? '',
            defaultChatId: e['CHANNEL_FEISHU_DEFAULT_CHAT_ID'] ?? '',
            encryptKey: e['CHANNEL_FEISHU_ENCRYPT_KEY'] ?? null,
            verificationToken: e['CHANNEL_FEISHU_VERIFICATION_TOKEN'] ?? null,
          },
        }),
      },
      flight: {
        ...(e['QUANT_FLIGHT_TARGET'] && { target: e['QUANT_FLIGHT_TARGET'] }),
        ...(e['QUANT_FLIGHT_PORT'] && { port: Number(e['QUANT_FLIGHT_PORT']) }),
      },
      instruction: {
        ...(e['INSTRUCTION_IM_ALLOWLIST'] && {
          imAllowlist: new Set(csv(e['INSTRUCTION_IM_ALLOWLIST'])),
        }),
        ...(e['INSTRUCTION_DEBUG_ENABLED'] && {
          debugInstructionsEnabled: truthy(e['INSTRUCTION_DEBUG_ENABLED']),
        }),
      },
      llm: {
        default: {
          ...(e['LLM_PROVIDER'] && { provider: e['LLM_PROVIDER'] }),
          ...(e['LLM_MODEL'] && { model: e['LLM_MODEL'] }),
        },
        agent: {
          ...(e['AGENT_LLM_PROVIDER'] && { provider: e['AGENT_LLM_PROVIDER'] }),
          ...(e['AGENT_LLM_MODEL'] && { model: e['AGENT_LLM_MODEL'] }),
        },
        ...(e['LLM_REQUEST_TIMEOUT_MS'] && {
          requestTimeoutMs: Number(e['LLM_REQUEST_TIMEOUT_MS']),
        }),
        ...(e['AGENT_MAX_TOOL_CALLS'] && {
          agentLoop: { defaultMaxToolCalls: Number(e['AGENT_MAX_TOOL_CALLS']) },
        }),
      },
      server: {
        ...(e['API_HOST'] && { host: e['API_HOST'] }),
        ...(e['API_PORT'] && { port: Number(e['API_PORT']) }),
        ...(e['QUANT_LOG_LEVEL'] && {
          logLevel: e['QUANT_LOG_LEVEL'].toUpperCase() as
            | 'DEBUG'
            | 'INFO'
            | 'WARN'
            | 'ERROR'
            | 'FATAL',
        }),
        ...(e['QUANT_ALLOWED_ORIGINS'] && {
          allowedOrigins: csv(e['QUANT_ALLOWED_ORIGINS']),
        }),
        ...(e['US_WATCH_SOURCE'] === 'akshare' && { usWatchSource: 'akshare' }),
      },
    },
    { force: true },
  );
}
