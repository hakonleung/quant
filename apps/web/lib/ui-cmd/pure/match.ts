/**
 * Pure sequence matcher.
 *
 * Given a typed-so-far buffer and the set of currently-active bindings,
 * decide whether the buffer is an exact hit, a viable prefix of a longer
 * binding, or a dead end.
 *
 * Sub-scope shadows parent: if both `'MKT.sector'` and `'MKT'` claim the
 * same `'d d'`, the sub-scope wins when its predicate is true.
 */

import type { KeySequence, Scope, UiBinding, UiCtx } from '../types.js';
import { isPrefixOf } from './parse-keys.js';
import { isScopeActive, scopeSpecificity } from './scope.js';

export type MatchResult =
  | { readonly kind: 'exact'; readonly cellId: string }
  | { readonly kind: 'partial' }
  | { readonly kind: 'none' };

export function matchSequence(
  buffer: KeySequence,
  bindings: readonly UiBinding[],
  ctx: UiCtx,
): MatchResult {
  if (buffer.length === 0) return { kind: 'none' };

  const active = bindings.filter((b) => bindingApplies(b, ctx));

  let bestExact: UiBinding | null = null;
  let bestExactSpec = -1;
  let hasPartial = false;

  for (const b of active) {
    if (sequenceEquals(b.seq, buffer)) {
      const spec = scopeSpecificity(b.ui.scope as Scope);
      if (spec > bestExactSpec) {
        bestExact = b;
        bestExactSpec = spec;
      }
    } else if (isPrefixOf(buffer, b.seq)) {
      hasPartial = true;
    }
  }

  if (bestExact !== null) return { kind: 'exact', cellId: bestExact.cellId };
  if (hasPartial) return { kind: 'partial' };
  return { kind: 'none' };
}

function bindingApplies(b: UiBinding, ctx: UiCtx): boolean {
  if (!isScopeActive(b.ui.scope as Scope, ctx)) return false;
  return b.ui.when?.(ctx) ?? true;
}

function sequenceEquals(a: KeySequence, b: KeySequence): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
