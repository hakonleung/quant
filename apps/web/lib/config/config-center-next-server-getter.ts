/**
 * Server-only ConfigCenter for Next.js (server components, route
 * handlers, server actions). Trusts the env file. Only writes fields
 * env actually provides — defaults come from `@quant/config`.
 */

import { ServerConfigCenter } from '@quant/config/server';

export function getServerConfig(): ServerConfigCenter {
  try {
    return ServerConfigCenter.get();
  } catch {
    const e = process.env;
    const feishuAppId = e['CHANNEL_FEISHU_APP_ID'];
    const feishuAppSecret = e['CHANNEL_FEISHU_APP_SECRET'];
    return ServerConfigCenter.init({
      auth: {
        ...(e['AUTH_MODE'] === 'oauth' && { mode: 'oauth' }),
        ...(e['NEXTAUTH_SECRET'] && { nextauthSecret: e['NEXTAUTH_SECRET'] }),
        ...(e['NEXTAUTH_URL'] && { nextauthUrl: e['NEXTAUTH_URL'] }),
        ...(e['QUANT_DATA_ROOT'] && { dataRoot: e['QUANT_DATA_ROOT'] }),
        ...(e['AUTH_ADMIN_USER_IDS'] && {
          adminUserIds: new Set(
            e['AUTH_ADMIN_USER_IDS']
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s.length > 0),
          ),
        }),
      },
      ...(feishuAppId &&
        feishuAppSecret && {
          channel: {
            feishu: {
              appId: feishuAppId,
              appSecret: feishuAppSecret,
              defaultChatId: e['CHANNEL_FEISHU_DEFAULT_CHAT_ID'] ?? '',
              encryptKey: e['CHANNEL_FEISHU_ENCRYPT_KEY'] ?? null,
              verificationToken: e['CHANNEL_FEISHU_VERIFICATION_TOKEN'] ?? null,
            },
          },
        }),
    });
  }
}
