/**
 * Resolves the authenticated user for both the Web (HTTP) and IM
 * (channel inbound) entry points. Both paths converge on a single
 * `AuthenticatedUser` shape so downstream services don't care where
 * the userId came from.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';

import { AUTH_CONFIG, type AuthConfigShape } from './config/auth.config.js';
import { deriveUserId } from './ports/oauth-provider.port.js';
import { SESSION_VERIFIER, type SessionVerifier } from './ports/session-verifier.port.js';
import type { AuthenticatedUser } from './request-with-user.js';
import { UserStore, type UserRecord } from './user.store.js';

const NEXTAUTH_COOKIE_NAMES = [
  'next-auth.session-token',
  '__Secure-next-auth.session-token',
] as const;

const BEARER_PREFIX = 'Bearer ';

export interface FeishuImSender {
  readonly openId: string;
  readonly displayName?: string;
  readonly tenantKey?: string | null;
}

@Injectable()
export class AuthService {
  private adminSeeded = false;

  constructor(
    @Inject(AUTH_CONFIG) private readonly cfg: AuthConfigShape,
    @Inject(UserStore) private readonly users: UserStore,
    @Inject(SESSION_VERIFIER) private readonly verifier: SessionVerifier,
  ) {}

  /**
   * HTTP-side resolution:
   *   1. AUTH_MODE=disabled → admin user (lazy-seeded).
   *   2. Authorization: Bearer <jwt> (BFF path, primary).
   *   3. NextAuth session cookie (Socket.IO upgrade or direct browser).
   *   4. Else null → guard returns 401.
   */
  async resolveFromHttp(req: Request): Promise<AuthenticatedUser | null> {
    if (this.cfg.mode === 'disabled') return this.adminUser();
    const token = readBearer(req) ?? readCookieToken(req);
    if (token === null) return null;
    const claims = await this.verifier.verify(token);
    if (claims === null) return null;
    const record = this.users.get(claims.userId);
    const displayName = record?.displayName ?? claims.displayName;
    const imBootstrap = record !== null && record.lastLoginAt === null;
    return {
      id: claims.userId,
      displayName,
      source: 'oauth',
      imBootstrap,
    };
  }

  /**
   * IM-side resolution: trust the Feishu sender. Auto-creates the user
   * record on first contact with `lastLoginAt: null`, which leaves the
   * user in `imBootstrap` state until they complete a Web login.
   */
  async resolveFromIm(sender: FeishuImSender): Promise<AuthenticatedUser> {
    const tenantKey = sender.tenantKey ?? null;
    const id = deriveUserId('feishu', sender.openId, tenantKey);
    const existing = this.users.get(id);
    if (existing !== null) {
      return {
        id,
        displayName: existing.displayName,
        source: 'im',
        imBootstrap: existing.lastLoginAt === null,
      };
    }
    const now = new Date().toISOString();
    const record: UserRecord = {
      id,
      provider: 'feishu',
      externalId: sender.openId,
      tenantKey,
      displayName: sender.displayName ?? sender.openId,
      email: null,
      avatarUrl: null,
      createdAt: now,
      lastLoginAt: null,
    };
    await this.users.upsert(record);
    return { id, displayName: record.displayName, source: 'im', imBootstrap: true };
  }

  /** Called by `/api/auth/sync` (or similar) after a successful Web login. */
  async touchWebLogin(record: Omit<UserRecord, 'createdAt' | 'lastLoginAt'>): Promise<UserRecord> {
    const now = new Date().toISOString();
    const existing = this.users.get(record.id);
    const merged: UserRecord = {
      ...record,
      createdAt: existing?.createdAt ?? now,
      lastLoginAt: now,
    };
    await this.users.upsert(merged);
    return merged;
  }

  private async adminUser(): Promise<AuthenticatedUser> {
    if (!this.adminSeeded) {
      await this.users.ensureAdminSeed();
      this.adminSeeded = true;
    }
    return {
      id: this.cfg.adminUserId,
      displayName: 'admin',
      source: 'env',
      imBootstrap: false,
    };
  }
}

function readBearer(req: Request): string | null {
  const raw = req.header('authorization') ?? req.header('Authorization');
  if (raw === undefined) return null;
  if (!raw.startsWith(BEARER_PREFIX)) return null;
  const token = raw.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

function readCookieToken(req: Request): string | null {
  const header = req.header('cookie');
  if (header === undefined) return null;
  for (const name of NEXTAUTH_COOKIE_NAMES) {
    const value = pickCookie(header, name);
    if (value !== null) return value;
  }
  return null;
}

function pickCookie(header: string, name: string): string | null {
  const parts = header.split(';');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k !== name) continue;
    const v = part.slice(eq + 1).trim();
    return v.length > 0 ? decodeURIComponent(v) : null;
  }
  return null;
}
