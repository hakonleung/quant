import { Controller, Get } from '@nestjs/common';

import { AllowAnon } from '../modules/auth/public.decorator.js';

interface HealthResponse {
  readonly status: 'ok';
  readonly service: 'api';
}

@AllowAnon()
@Controller('health')
export class HealthController {
  @Get()
  check(): HealthResponse {
    return { status: 'ok', service: 'api' };
  }
}
