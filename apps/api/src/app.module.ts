import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { HealthController } from './common/health.controller.js';
import { TraceMiddleware } from './common/trace.middleware.js';

@Module({
  imports: [],
  controllers: [HealthController],
  providers: [TraceMiddleware],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TraceMiddleware).forRoutes('*');
  }
}
