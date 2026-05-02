/**
 * Base class for all cross-process domain errors. Mirrors the Python `QuantError`
 * in services/py/quant_core/errors.py. Error `code` strings MUST match across
 * languages (see proto/errors.proto, defined later in M2).
 */
export class QuantError extends Error {
  public readonly code: string;
  public readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'QuantError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}
