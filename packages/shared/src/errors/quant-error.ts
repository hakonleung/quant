import type { ErrorCode } from '../contracts/errors.js';

/**
 * Base class for all cross-process domain errors. Mirrors the Python `QuantError`
 * in services/py/quant_core/errors.py. The `code` set is generated from
 * proto/errors.json; both languages import the same closed enum.
 */
export class QuantError extends Error {
  public readonly code: ErrorCode;
  public readonly details: Readonly<Record<string, unknown>>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'QuantError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}
