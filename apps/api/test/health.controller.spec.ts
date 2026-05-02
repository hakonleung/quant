import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { HealthController } from '../src/common/health.controller.js';

describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
    }).compile();
    controller = module.get(HealthController);
  });

  it('should return ok status with service name', () => {
    expect(controller.check()).toEqual({ status: 'ok', service: 'api' });
  });

  it('should return a frozen-shape response (regression: never leak internal state)', () => {
    const a = controller.check();
    const b = controller.check();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
