// GENERATED FILE — DO NOT EDIT BY HAND
// Source: proto/errors.json
// Regenerate: pnpm gen:proto

export const ERROR_CODES = [
  'OK',
  'INVALID_ARGUMENT',
  'NOT_FOUND',
  'STOCK_NOT_FOUND',
  'META_STALE',
  'KLINE_DATA_MISSING',
  'DSL_INVALID',
  'NL_TRANSLATION_FAILED',
  'EVALUATION_FAILED',
  'UNIVERSE_TOO_LARGE',
  'PATTERN_REFERENCE_LOOKAHEAD',
  'SOURCE_UNAVAILABLE',
  'RATE_LIMITED',
  'LLM_FAILED',
  'CACHE_CORRUPTED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

// Set<string> (not Set<ErrorCode>) so the type guard below has no `as` cast.
const codeSet: ReadonlySet<string> = new Set<string>(ERROR_CODES);

export const ERROR_NUMBERS: Readonly<Record<ErrorCode, number>> = Object.freeze({
  OK: 0,
  INVALID_ARGUMENT: 1,
  NOT_FOUND: 2,
  STOCK_NOT_FOUND: 100,
  META_STALE: 101,
  KLINE_DATA_MISSING: 102,
  DSL_INVALID: 200,
  NL_TRANSLATION_FAILED: 201,
  EVALUATION_FAILED: 202,
  UNIVERSE_TOO_LARGE: 203,
  PATTERN_REFERENCE_LOOKAHEAD: 300,
  SOURCE_UNAVAILABLE: 400,
  RATE_LIMITED: 401,
  LLM_FAILED: 500,
  CACHE_CORRUPTED: 600,
  INTERNAL: 999,
});

export const ERROR_HTTP_STATUS: Readonly<Record<ErrorCode, number>> = Object.freeze({
  OK: 200,
  INVALID_ARGUMENT: 400,
  NOT_FOUND: 404,
  STOCK_NOT_FOUND: 404,
  META_STALE: 503,
  KLINE_DATA_MISSING: 503,
  DSL_INVALID: 400,
  NL_TRANSLATION_FAILED: 502,
  EVALUATION_FAILED: 500,
  UNIVERSE_TOO_LARGE: 400,
  PATTERN_REFERENCE_LOOKAHEAD: 400,
  SOURCE_UNAVAILABLE: 503,
  RATE_LIMITED: 503,
  LLM_FAILED: 502,
  CACHE_CORRUPTED: 500,
  INTERNAL: 500,
});

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && codeSet.has(value);
}
