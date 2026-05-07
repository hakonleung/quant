import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { HealthController } from './common/health.controller.js';
import { TraceMiddleware } from './common/trace.middleware.js';
import { BlacklistModule } from './modules/blacklist/blacklist.module.js';
import { ChannelCommandService } from './modules/channel/channel-command.service.js';
import { ChannelModule } from './modules/channel/channel.module.js';
import { KlineModule } from './modules/kline/kline.module.js';
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
    // Channel must come before SocketModule.forRoot so the
    // ChannelCommandService provider exists when the socket module
    // resolves SOCKET_COMMAND_HANDLER via `useExisting`.
    ChannelModule,
    SocketModule.forRoot({ imports: [ChannelModule], commandHandler: ChannelCommandService }),
    BlacklistModule,
    StockMetaModule,
    OrchestrationModule,
    KlineModule,
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
