import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { HealthController } from './common/health.controller.js';
import { TraceMiddleware } from './common/trace.middleware.js';
import { KlineModule } from './modules/kline/kline.module.js';
import { OrchestrationModule } from './modules/orchestration/orchestration.module.js';
import { PatternModule } from './modules/pattern/pattern.module.js';
import { PushModule } from './modules/push/push.module.js';
import { ScreenModule } from './modules/screen/screen.module.js';
import { SectorsModule } from './modules/sectors/sectors.module.js';
import { SentimentModule } from './modules/sentiment/sentiment.module.js';
import { StockMetaModule } from './modules/stock-meta/stock-meta.module.js';
import { SysCfgModule } from './modules/sys-cfg/sys-cfg.module.js';
import { WatchModule } from './modules/watch/watch.module.js';

@Module({
  imports: [
    StockMetaModule,
    OrchestrationModule,
    KlineModule,
    SentimentModule,
    ScreenModule,
    PatternModule,
    PushModule,
    WatchModule,
    SectorsModule,
    SysCfgModule,
  ],
  controllers: [HealthController],
  providers: [TraceMiddleware],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TraceMiddleware).forRoutes('*');
  }
}
