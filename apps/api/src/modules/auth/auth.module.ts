import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { FeishuOAuthProvider } from './adapters/feishu.provider.js';
import { NextauthJwtVerifier } from './adapters/nextauth-jwt.verifier.js';
import { AuthBootstrap } from './auth.bootstrap.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import {
  AUTH_CONFIG,
  AuthConfig,
  loadAuthConfig,
  type AuthConfigShape,
} from './config/auth.config.js';
import { OAUTH_PROVIDERS, type OAuthProvider } from './ports/oauth-provider.port.js';
import { SESSION_VERIFIER, type SessionVerifier } from './ports/session-verifier.port.js';
import { UserStore } from './user.store.js';

const FEISHU_APP_ID_ENV = 'CHANNEL_FEISHU_APP_ID';
const FEISHU_APP_SECRET_ENV = 'CHANNEL_FEISHU_APP_SECRET';

@Global()
@Module({
  controllers: [AuthController],
  providers: [
    { provide: AUTH_CONFIG, useFactory: (): AuthConfigShape => loadAuthConfig() },
    AuthConfig,
    AuthBootstrap,
    UserStore,
    {
      provide: SESSION_VERIFIER,
      inject: [AUTH_CONFIG],
      useFactory: (cfg: AuthConfigShape): SessionVerifier => new NextauthJwtVerifier(cfg.nextauthSecret),
    },
    {
      provide: OAUTH_PROVIDERS,
      inject: [AUTH_CONFIG],
      useFactory: (cfg: AuthConfigShape): readonly OAuthProvider[] => {
        const appId = process.env[FEISHU_APP_ID_ENV] ?? '';
        const appSecret = process.env[FEISHU_APP_SECRET_ENV] ?? '';
        if (appId.length === 0 || appSecret.length === 0) return [];
        return [new FeishuOAuthProvider(appId, appSecret, cfg)];
      },
    },
    AuthService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuthConfig, AuthService, UserStore, AUTH_CONFIG, SESSION_VERIFIER, OAUTH_PROVIDERS],
})
export class AuthModule {}
