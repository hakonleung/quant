/**
 * Generic `PipeTransform` that validates an incoming Express payload
 * (body / query / params) against a Zod schema and converts validation
 * failures into `QuantError(INVALID_ARGUMENT)` so the global filter
 * maps them to HTTP 400 with the standard envelope.
 */

import { Injectable, type PipeTransform } from '@nestjs/common';
import { QuantError } from '@quant/shared';
import { ZodError, type ZodTypeAny, type output as ZodOutput } from 'zod';

/**
 * Generic Zod-validating Nest pipe. `S extends ZodTypeAny` keeps it usable
 * with schemas that include `transform()` (input ≠ output) — for those
 * Nest hands us the raw query/body string and we hand back the parsed
 * shape, so accepting `unknown` as input is correct.
 */
@Injectable()
export class ZodValidationPipe<S extends ZodTypeAny> implements PipeTransform {
  constructor(private readonly schema: S) {}

  transform(value: unknown): ZodOutput<S> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new QuantError('INVALID_ARGUMENT', flattenZodError(result.error), {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
          code: issue.code,
        })),
      });
    }
    // `result.data` is typed `any` for ZodTypeAny; the schema's contract
    // (validated above) guarantees it is `ZodOutput<S>`.
    const data = result.data as ZodOutput<S>;
    return data;
  }
}

function flattenZodError(err: ZodError): string {
  return err.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '<root>'}: ${issue.message}`)
    .join('; ');
}
