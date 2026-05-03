import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { HealthController } from './common/health.controller.js';
import { TraceMiddleware } from './common/trace.middleware.js';
import { OrchestrationModule } from './modules/orchestration/orchestration.module.js';
import { StockMetaModule } from './modules/stock-meta/stock-meta.module.js';

@Module({
  imports: [StockMetaModule, OrchestrationModule],
  controllers: [HealthController],
  providers: [TraceMiddleware],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TraceMiddleware).forRoutes('*');
  }
}
