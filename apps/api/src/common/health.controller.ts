import { Controller, Get } from '@nestjs/common';

interface HealthResponse {
  readonly status: 'ok';
  readonly service: 'api';
}

@Controller('health')
export class HealthController {
  @Get()
  check(): HealthResponse {
    return { status: 'ok', service: 'api' };
  }
}
