/**
 * Server-side Feishu OAuth provider. The Web login flow runs through
 * NextAuth (`apps/web/lib/auth/feishu-provider.ts`); this adapter exists
 * for symmetry and for any future server-driven flow (bot relogin,
 * device code, etc.). The two implementations agree on the userId
 * derivation so identities unify.
 */

import { Injectable } from '@nestjs/common';
import { request } from 'undici';

import type { AuthConfigShape } from '../config/auth.config.js';
import type { OAuthProvider, OAuthUserInfo } from '../ports/oauth-provider.port.js';

const FEISHU_AUTHORIZE = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize';
const FEISHU_APP_ACCESS = 'https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal';
const FEISHU_TOKEN = 'https://open.feishu.cn/open-apis/authen/v1/oidc/access_token';
const FEISHU_USERINFO = 'https://open.feishu.cn/open-apis/authen/v1/user_info';

interface AppAccessTokenResponse {
  readonly code: number;
  readonly app_access_token: string;
  readonly expire: number;
}

interface UserAccessTokenResponse {
  readonly code: number;
  readonly data?: { access_token: string; expires_in: number };
}

interface UserInfoResponse {
  readonly code: number;
  readonly data?: {
    open_id: string;
    name?: string;
    email?: string;
    avatar_url?: string;
    tenant_key?: string;
  };
}

@Injectable()
export class FeishuOAuthProvider implements OAuthProvider {
  readonly id = 'feishu' as const;
  private appToken: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    _cfg: AuthConfigShape,
  ) {}

  authorizeUrl(state: string, redirectUri: string): string {
    const url = new URL(FEISHU_AUTHORIZE);
    url.searchParams.set('app_id', this.appId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    return url.toString();
  }

  async exchangeCode(
    code: string,
    _redirectUri: string,
    traceId: string,
  ): Promise<{ accessToken: string; expiresInSec: number }> {
    const appAccess = await this.getAppAccessToken(traceId);
    const res = await request(FEISHU_TOKEN, {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${appAccess}`,
      },
      body: JSON.stringify({ grant_type: 'authorization_code', code }),
    });
    const json = (await res.body.json()) as UserAccessTokenResponse;
    if (json.code !== 0 || json.data === undefined) {
      throw new Error(`feishu_token_exchange_failed code=${String(json.code)} trace=${traceId}`);
    }
    return { accessToken: json.data.access_token, expiresInSec: json.data.expires_in };
  }

  async fetchUserInfo(accessToken: string, traceId: string): Promise<OAuthUserInfo> {
    const res = await request(FEISHU_USERINFO, {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const json = (await res.body.json()) as UserInfoResponse;
    if (json.code !== 0 || json.data === undefined) {
      throw new Error(`feishu_userinfo_failed code=${String(json.code)} trace=${traceId}`);
    }
    const d = json.data;
    return {
      externalId: d.open_id,
      displayName: d.name ?? d.open_id,
      email: d.email ?? null,
      avatarUrl: d.avatar_url ?? null,
      tenantKey: d.tenant_key ?? null,
    };
  }

  private async getAppAccessToken(traceId: string): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    if (this.appToken !== null && this.appToken.expiresAt - 60 > now) {
      return this.appToken.value;
    }
    const res = await request(FEISHU_APP_ACCESS, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const json = (await res.body.json()) as AppAccessTokenResponse;
    if (json.code !== 0) {
      throw new Error(`feishu_app_token_failed code=${String(json.code)} trace=${traceId}`);
    }
    this.appToken = { value: json.app_access_token, expiresAt: now + json.expire };
    return json.app_access_token;
  }
}
