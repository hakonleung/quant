/**
 * Pure scope-activation predicate.
 *
 * Rules (RFC 0004 §3):
 *   - `'global'`              → always active.
 *   - `<Feat>`                → active iff `ctx.activeFeat === <Feat>`.
 *   - `<Feat>.<sub>`          → active iff above AND `<sub>` sits at the
 *                               TOP of `ctx.subFocus` (deepest last).
 */

import type { Scope, UiCtx } from '../types.js';

export function isScopeActive(scope: Scope, ctx: UiCtx): boolean {
  if (scope === 'global') return true;
  const dotIdx = scope.indexOf('.');
  if (dotIdx === -1) return ctx.activeFeat === scope;
  const feat = scope.slice(0, dotIdx);
  const sub = scope.slice(dotIdx + 1);
  if (ctx.activeFeat !== feat) return false;
  return ctx.subFocus.at(-1) === sub;
}

/** Sub-scopes shadow their parent — used by the matcher's ranker. */
export function scopeSpecificity(scope: Scope): number {
  if (scope === 'global') return 0;
  return scope.includes('.') ? 2 : 1;
}
