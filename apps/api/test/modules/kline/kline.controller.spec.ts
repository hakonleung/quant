/**
 * Regression: `KlineController.constructor(reader: KlineReaderService)` must
 * be decorated with `@Inject()` because the project uses SWC, which doesn't
 * emit decorator metadata for parameter-type-based DI. Without it, the
 * constructor parameter resolves to ``undefined`` at request time and
 * every kline endpoint 500s with
 * "Cannot read properties of undefined (reading 'lastNForCode')".
 *
 * The cheapest guard: boot the controller via the real Nest DI container
 * and assert ``this.reader`` is the injected instance. A unit `new
 * KlineController(stub)` wouldn't catch the regression because that
 * bypasses Nest entirely.
 */

import { Test } from '@nestjs/testing';

import { KlineController } from '../../../src/modules/kline/kline.controller.js';
import { KlineReaderService } from '../../../src/modules/kline/kline-reader.service.js';

class FakeReader {
  async lastNForCode(): Promise<readonly unknown[]> {
    return [];
  }
  async lastNBulk(): Promise<Record<string, readonly unknown[]>> {
    return {};
  }
}

describe('KlineController DI wiring (SWC + Nest)', () => {
  it('resolves KlineReaderService into the controller via the container', async () => {
    const mod = await Test.createTestingModule({
      controllers: [KlineController],
      providers: [{ provide: KlineReaderService, useClass: FakeReader }],
    }).compile();

    const ctrl = mod.get(KlineController);
    // The whole point of this test: if the @Inject() decorator goes missing
    // again, Nest leaves the parameter undefined and this access throws.
    const reader = (ctrl as unknown as { reader: unknown }).reader;
    expect(reader).toBeInstanceOf(FakeReader);
  });
});
