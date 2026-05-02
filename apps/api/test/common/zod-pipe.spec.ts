import { z } from 'zod';
import { QuantError } from '@quant/shared';
import { ZodValidationPipe } from '../../src/common/zod-pipe.js';

const Schema = z
  .object({
    name: z.string().min(1),
    age: z.coerce.number().int().nonnegative(),
  })
  .strict();

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(Schema);

  it('returns parsed data for a valid payload', () => {
    expect(pipe.transform({ name: 'a', age: '17' })).toEqual({ name: 'a', age: 17 });
  });

  it('throws QuantError(INVALID_ARGUMENT) on validation failure', () => {
    expect(() => pipe.transform({ name: '', age: -1 })).toThrow(QuantError);
  });

  it('attaches issue paths to QuantError.details', () => {
    let caught: unknown = null;
    try {
      pipe.transform({ name: '', age: -1 });
    } catch (err) {
      caught = err;
    }
    const err = caught as QuantError;
    expect(err.code).toBe('INVALID_ARGUMENT');
    const issues = err.details['issues'] as readonly { path: string }[];
    expect(issues.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects unknown extra keys when schema is strict', () => {
    expect(() => pipe.transform({ name: 'a', age: 1, extra: 'x' })).toThrow(QuantError);
  });
});
