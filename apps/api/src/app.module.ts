import { Module } from '@nestjs/common';
import { HealthController } from './common/health.controller.js';

@Module({
  imports: [],
  controllers: [HealthController],
  providers: [],
})
export class AppModule {}
