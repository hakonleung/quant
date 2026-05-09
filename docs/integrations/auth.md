# Auth & Multi-User

> Where the user identity comes from, who issues the session, and how it
> propagates through the three processes (browser → Next.js BFF → NestJS).

## Modes

`AUTH_MODE` is a single env var consumed by both the API (`apps/api`) and
the web (`apps/web`). The two ends MUST agree:

| Mode       | Behaviour                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------- |
| `disabled` | Every request inherits a synthetic `admin` user. Per-user dir at `data/users/admin/`. Default.    |
| `oauth`    | Web requires Feishu OAuth login. Per-user dir at `data/users/${userId}/` for `feishu:${open_id}`. |

The web side reads `NEXT_PUBLIC_AUTH_MODE` (Next.js can't see private env
vars in the browser bundle) — keep both vars in sync.

## Architecture

```
Browser ──cookie──> Next.js (BFF) ──Bearer JWT──> NestJS (AuthGuard)
                         │  app/api/_lib/proxy.ts          │  modules/auth/*
                         │  /login, middleware             │  UserScopedJsonStore<T>
                         ▼                                 ▼
                    /api/auth/feishu/*              data/users/{uid}/...
```

- The browser only ever talks to the same-origin Next.js server. Every
  business call routes through the BFF (`apps/web/app/api/_lib/proxy.ts`),
  which calls `getSession()` and attaches `Authorization: Bearer <jwt>`
  for the downstream NestJS hop.
- Socket.IO is the one direct browser → NestJS path. The browser sends
  the `next-auth.session-token` cookie via `withCredentials: true`; the
  gateway verifies the same token with the same secret.
- One shared secret: `NEXTAUTH_SECRET` (HMAC-SHA256). The web side mints
  the JWT, the API side verifies it. No external dependency on
  `jose` / `next-auth/jwt` — both ends use Node's built-in `crypto`.

## Login flow (Feishu)

1. User hits `/` → middleware sees no cookie → redirect to `/login`.
2. User clicks "用飞书登录" → `GET /api/auth/feishu/start` plants a CSRF
   `state` cookie and redirects to Feishu authorize URL.
3. Feishu calls back to `/api/auth/callback/feishu?code=…&state=…`.
4. The route verifies `state`, exchanges `code` for an `app_access_token`
   then a `user_access_token`, fetches `/user_info`, and mints
   `feishu:${open_id}` (or `feishu:${tenant_key}:${open_id}` multi-tenant).
5. Session JWT (HS256) is set as `next-auth.session-token` httpOnly cookie.
6. Best-effort `POST /api/auth/sync` to NestJS so `lastLoginAt` updates.
7. Browser redirects to `/`.

## userId derivation (single source of truth)

```
userId = `${provider}:${externalId}`                       # single tenant
       | `${provider}:${tenantKey}:${externalId}`          # multi-tenant
```

Used by **both** the OAuth web flow and the IM inbound dispatcher in
`AuthService.resolveFromIm`. The same person logging in via Web AND
messaging the bot via Feishu resolves to the same `userId`, so their
data directory unifies automatically.

## IM-driven implicit auth

The Feishu WSClient pushes are signed by Feishu, so
`event.sender.sender_id.open_id` is treated as a **trusted identity** —
equivalent to a logged-in session for the purpose of issuing read
commands.

- Read-only IM commands (e.g. `/watch list`) work for any user, including
  one we've never seen on the Web side. `AuthService.resolveFromIm`
  auto-creates the `UserStore` record with `lastLoginAt: null`,
  `imBootstrap: true`.
- Write commands MUST gate on `imBootstrap === false`; the dispatcher
  responds with a "Web 登录后再试" message until the user completes a
  first OAuth login. (Phase 3 work-in-progress: dispatcher landing in
  `instruction.im.listener.ts` reads `ctx.imBootstrap`; per-handler
  enforcement is each handler's responsibility.)
- IM never goes through the HTTP `AuthGuard`. The dispatcher converts
  `(channel, sender)` directly into a `userId` and calls services with
  it. **Do not** "unify" IM with HTTP by faking a request — internal
  trusted entry point.

## Per-user storage

`apps/api/src/common/user-scoped-store.ts` is the single helper backing
all five user-scoped stores:

| Store           | File                                     |
| --------------- | ---------------------------------------- |
| Ledger entries  | `data/users/{uid}/_ledger/entries.json`  |
| Ledger AI cache | `data/users/{uid}/_ledger/ai-cache.json` |
| Watch tasks     | `data/users/{uid}/watch/tasks.json`      |
| Watch groups    | `data/users/{uid}/watch/groups.json`     |
| Sys-Cfg         | `data/users/{uid}/sys-cfg/sys-cfg.json`  |
| User registry   | `data/users/_meta/users.json`            |

Shared (NOT user-scoped): `data/kline/`, `data/sectors/`, `data/blacklist.json`,
`data/sentiment/`, `data/ta/`, `data/meta/`, `data/watch/universe_*.json`.

## Migration

The first boot under the new code automatically relocates legacy files
into `data/users/admin/...` (defensive migration in
`AuthModule.onModuleInit`). For headless / scripted migration:

```sh
pnpm tsx scripts/migrate_users_v1.ts
```

Idempotent: refuses to run if `data/users/admin` already exists.

## Cross-process boundaries

- **Flight RPC**: stays user-agnostic. `userId` is a NestJS-frame
  concept; the Python compute service receives raw payloads only.
  `services/py/quant_rpc/middleware.py` only propagates `x-trace-id`.
- **Cookie / cross-origin**: only the BFF path requires no cookie sharing.
  Socket.IO uses the cookie directly (same host, different port — Lax
  SameSite suffices). Production should reverse-proxy the API behind
  the same origin as the web to avoid SameSite gotchas.

## Adding another OAuth provider

1. Implement `OAuthProvider` (`ports/oauth-provider.port.ts`) for the
   API side (server-driven flows, optional).
2. Add a route handler under `apps/web/app/api/auth/<provider>/start`
   and `/callback/<provider>` mirroring `feishu`.
3. Reuse `signSession()` / `getSession()` and `deriveUserId()`. The
   resulting userId of the form `${provider}:${externalId}` plugs in
   without changes elsewhere.
