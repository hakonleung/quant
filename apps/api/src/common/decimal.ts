/**
 * Module-scoped `Decimal` constructor for all in-process arithmetic in
 * apps/api.
 *
 * Cloned from `decimal.js` so settings (precision, rounding) are local
 * — other libraries that import `Decimal` directly stay unaffected.
 *
 * Precision 28 + ROUND_HALF_EVEN matches CPython's `decimal.Decimal`
 * default context, so divisions produce the same canonical string as
 * the Python projector did during the storage-unify era. The matching
 * config is what makes Py↔TS parity tests possible.
 */

import { Decimal } from 'decimal.js';

export const D = Decimal.clone({
  precision: 28,
  rounding: Decimal.ROUND_HALF_EVEN,
});
export type Dec = InstanceType<typeof D>;
