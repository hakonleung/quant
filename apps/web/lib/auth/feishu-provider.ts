/**
 * Server-only Feishu OAuth helper. Owns the two-step token dance:
 *   1. POST /open-apis/auth/v3/app_access_token/internal  → app_access_token
 *   2. POST /open-apis/authen/v1/oidc/access_token        → user access_token
 * Then GETs /open-apis/authen/v1/user_info to materialise a `FeishuProfile`.
 */

const AUTHORIZE_URL = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize';
const APP_TOKEN_URL = 'https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal';
const TOKEN_URL = 'https://open.feishu.cn/open-apis/authen/v1/oidc/access_token';
const USERINFO_URL = 'https://open.feishu.cn/open-apis/authen/v1/user_info';

export interface FeishuProfile {
  readonly openId: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly avatarUrl: string | null;
  readonly tenantKey: string | null;
}

export function buildAuthorizeUrl(input: {
  appId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('app_id', input.appId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.state);
  return url.toString();
}

export async function exchangeCodeForProfile(input: {
  appId: string;
  appSecret: string;
  code: string;
}): Promise<FeishuProfile> {
  const appAccess = await fetchAppAccessToken(input.appId, input.appSecret);
  const userAccess = await fetchUserAccessToken(appAccess, input.code);
  return fetchUserInfo(userAccess);
}

interface AppTokenResp {
  readonly code: number;
  readonly app_access_token?: string;
  readonly msg?: string;
}

async function fetchAppAccessToken(appId: string, appSecret: string): Promise<string> {
  const res = await fetch(APP_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const json = (await res.json()) as AppTokenResp;
  if (json.code !== 0 || json.app_access_token === undefined) {
    throw new Error(`feishu_app_token_failed code=${String(json.code)} msg=${String(json.msg)}`);
  }
  return json.app_access_token;
}

interface UserTokenResp {
  readonly code: number;
  readonly data?: { access_token?: string };
  readonly msg?: string;
}

async function fetchUserAccessToken(appAccessToken: string, code: string): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${appAccessToken}`,
    },
    body: JSON.stringify({ grant_type: 'authorization_code', code }),
  });
  const json = (await res.json()) as UserTokenResp;
  const token = json.data?.access_token;
  if (json.code !== 0 || token === undefined) {
    throw new Error(`feishu_user_token_failed code=${String(json.code)} msg=${String(json.msg)}`);
  }
  return token;
}

interface UserInfoResp {
  readonly code: number;
  readonly data?: {
    open_id?: string;
    name?: string;
    email?: string;
    avatar_url?: string;
    tenant_key?: string;
  };
  readonly msg?: string;
}

async function fetchUserInfo(accessToken: string): Promise<FeishuProfile> {
  const res = await fetch(USERINFO_URL, {
    method: 'GET',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const json = (await res.json()) as UserInfoResp;
  const data = json.data;
  if (json.code !== 0 || data === undefined || data.open_id === undefined) {
    throw new Error(`feishu_userinfo_failed code=${String(json.code)} msg=${String(json.msg)}`);
  }
  return {
    openId: data.open_id,
    displayName: data.name ?? data.open_id,
    email: data.email ?? null,
    avatarUrl: data.avatar_url ?? null,
    tenantKey: data.tenant_key ?? null,
  };
}
