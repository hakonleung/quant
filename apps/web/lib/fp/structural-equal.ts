/**
 * Recursive structural equality for plain JSON values.
 *
 * Replaces the historical `JSON.stringify(a) === JSON.stringify(b)`
 * comparator used by the `useRemoteSync` debouncer. The stringify path
 * was small but allocated a large string for every store update —
 * sectors with embedded `evidence` records (a couple hundred stocks
 * each) burned a few ms on the main thread per snapshot, which
 * shifted the debounce timer and occasionally lost cache hits in
 * react-query.
 *
 * The implementation is intentionally narrow: it handles primitives,
 * plain arrays, and plain object records — i.e. the exact subset that
 * traverses the wire as JSON. It does not handle Map / Set / Date /
 * class instances; the input domain (zod-parsed payloads + zustand
 * slices that mirror them) doesn't contain any.
 *
 * Performance characteristics:
 *   - Reference equality short-circuits on identical inputs (Zustand
 *     usually preserves array identity unless a setState actually
 *     replaces the slice).
 *   - Length mismatch on arrays / key-count mismatch on objects exits
 *     in O(1) before any recursion.
 *   - Mismatching values exit on the first divergence; no allocation.
 *   - Strings, numbers, booleans, null, undefined compare with `===`.
 */

export function structuralEqual<T>(a: T, b: T): boolean {
  return eq(a, b);
}

function eq(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a)) return Array.isArray(b) && eqArray(a, b);
  if (Array.isArray(b)) return false;
  if (typeof a === 'object' && typeof b === 'object') return eqObject(a, b);
  // Two different primitive values that didn't match `Object.is`.
  return false;
}

function eqArray(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!eq(a[i], b[i])) return false;
  }
  return true;
}

function eqObject(a: object, b: object): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!eq(readKey(a, k), readKey(b, k))) return false;
  }
  return true;
}

function readKey(o: object, k: string): unknown {
  // `Reflect.get` keeps the read at `unknown` without an `as` cast.
  return Reflect.get(o, k);
}
