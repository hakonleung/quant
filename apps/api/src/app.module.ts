import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { HealthController } from './common/health.controller.js';
import { TraceMiddleware } from './common/trace.middleware.js';
import { KlineModule } from './modules/kline/kline.module.js';
import { OrchestrationModule } from './modules/orchestration/orchestration.module.js';
import { ScreenModule } from './modules/screen/screen.module.js';
import { SentimentModule } from './modules/sentiment/sentiment.module.js';
import { StockMetaModule } from './modules/stock-meta/stock-meta.module.js';

@Module({
  imports: [
    StockMetaModule,
    OrchestrationModule,
    KlineModule,
    SentimentModule,
    ScreenModule,
  ],
  controllers: [HealthController],
  providers: [TraceMiddleware],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TraceMiddleware).forRoutes('*');
  }
}
