import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ServerConfigCenter } from '@quant/config/server';

import { FeishuOAuthProvider } from './adapters/feishu.provider.js';
import { NextauthJwtVerifier } from './adapters/nextauth-jwt.verifier.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { AUTH_CONFIG, AuthConfig, type AuthConfigShape } from './config/auth.config.js';
import { OAUTH_PROVIDERS, type OAuthProvider } from './ports/oauth-provider.port.js';
import { SESSION_VERIFIER, type SessionVerifier } from './ports/session-verifier.port.js';
import { UserStore } from './user.store.js';

@Global()
@Module({
  controllers: [AuthController],
  providers: [
    {
      provide: AUTH_CONFIG,
      useFactory: (): AuthConfigShape => {
        const auth = ServerConfigCenter.get().auth;
        return {
          mode: auth.mode,
          nextauthSecret: auth.nextauthSecret,
          dataRoot: auth.dataRoot,
          adminUserId: auth.adminUserId,
          adminUserIds: auth.adminUserIds,
        };
      },
    },
    AuthConfig,
    UserStore,
    {
      provide: SESSION_VERIFIER,
      inject: [AUTH_CONFIG],
      useFactory: (cfg: AuthConfigShape): SessionVerifier =>
        new NextauthJwtVerifier(cfg.nextauthSecret),
    },
    {
      provide: OAUTH_PROVIDERS,
      inject: [AUTH_CONFIG],
      useFactory: (cfg: AuthConfigShape): readonly OAuthProvider[] => {
        const feishu = ServerConfigCenter.get().channel.feishu;
        if (feishu === null) return [];
        return [new FeishuOAuthProvider(feishu.appId, feishu.appSecret, cfg)];
      },
    },
    AuthService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AuthConfig, AuthService, UserStore, AUTH_CONFIG, SESSION_VERIFIER, OAUTH_PROVIDERS],
})
export class AuthModule {}
