import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { HealthController } from './common/health.controller.js';
import { TraceMiddleware } from './common/trace.middleware.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { BlacklistModule } from './modules/blacklist/blacklist.module.js';
import { ChannelModule } from './modules/channel/channel.module.js';
import { InstructionModule } from './modules/instruction/instruction.module.js';
import { SocketInstructionAdapter } from './modules/instruction/socket-instruction.adapter.js';
import { KlineModule } from './modules/kline/kline.module.js';
import { LedgerModule } from './modules/ledger/ledger.module.js';
import { LlmModule } from './modules/llm/llm.module.js';
import { OrchestrationModule } from './modules/orchestration/orchestration.module.js';
import { PatternModule } from './modules/pattern/pattern.module.js';
import { ScreenModule } from './modules/screen/screen.module.js';
import { SectorsModule } from './modules/sectors/sectors.module.js';
import { SentimentModule } from './modules/sentiment/sentiment.module.js';
import { SocketModule } from './modules/socket/socket.module.js';
import { StockMetaModule } from './modules/stock-meta/stock-meta.module.js';
import { SysCfgModule } from './modules/sys-cfg/sys-cfg.module.js';
import { TaModule } from './modules/ta/ta.module.js';
import { WatchModule } from './modules/watch/watch.module.js';

@Module({
  imports: [
    // AuthModule is global; must come first so the legacy → users/admin
    // boot-time migration runs before any per-user store loads.
    AuthModule,
    // LlmModule is @Global — every feature that calls an LLM imports
    // LlmService transparently. Place near the top so feature modules
    // resolved later don't race with provider construction.
    LlmModule,
    // Channel must come before InstructionModule so the channel.send
    // handler can inject ChannelService at registration time.
    ChannelModule,
    InstructionModule,
    // Instruction must come before SocketModule.forRoot so the
    // SocketInstructionAdapter provider exists when the socket module
    // resolves SOCKET_COMMAND_HANDLER via `useExisting`.
    SocketModule.forRoot({
      imports: [InstructionModule],
      commandHandler: SocketInstructionAdapter,
    }),
    BlacklistModule,
    StockMetaModule,
    OrchestrationModule,
    KlineModule,
    LedgerModule,
    SentimentModule,
    ScreenModule,
    PatternModule,
    WatchModule,
    SectorsModule,
    SysCfgModule,
    TaModule,
  ],
  controllers: [HealthController],
  providers: [TraceMiddleware],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TraceMiddleware).forRoutes('*');
  }
}
