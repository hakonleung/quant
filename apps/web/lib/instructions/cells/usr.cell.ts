/**
 * FE `/usr` cell — thin proxy to BE.
 *
 * Handler: `invokeInstruction('usr', {})` returns the same typed
 * `UsrResult` shape the BE cell handler produces (identity + LLM
 * ledger snapshot).
 *
 * Renderer: terminal-compact text. The IM surface renders a rich
 * multi-section table (BE's `renderUsr`); FE keeps it dense — same
 * structural data, different presentation.
 */

import type { InstructionCell, ResultOf } from '@quant/shared';
import { textErr, textOk } from '@quant/terminal';

import type { FeEnv } from '../fe-types.js';

type UsrResult = ResultOf<'usr'>;

export function buildUsrCell(): InstructionCell<FeEnv, 'usr'> {
  return {
    async handler(_args, ctx): Promise<UsrResult> {
      const env = await ctx.api.invoke('usr', {}, { signal: ctx.signal });
      if (!env.ok) throw new Error(env.error.message);
      return env.data;
    },
    renderer(envelope) {
      if (!envelope.ok) return textErr(envelope.error.message);
      return textOk(formatIdentity(envelope.data));
    },
  };
}

function formatIdentity(r: UsrResult): string {
  const lines: string[] = [
    `user_id    : ${r.identity.userId}`,
    `role       : ${r.identity.role}`,
    `source     : ${r.identity.source}`,
  ];
  if (r.identity.displayName !== undefined) {
    // Insert `display` right after `user_id` line.
    lines.splice(1, 0, `display    : ${r.identity.displayName}`);
  }
  if (r.identity.mappedFromUserId !== undefined) {
    lines.push(`mapped_from: ${r.identity.mappedFromUserId} (AUTH_ADMIN_USER_IDS)`);
  }
  if (r.identity.imBootstrap === true) {
    lines.push('bootstrap  : true (no Web login yet)');
  }
  if (r.ledger !== null) {
    lines.push('');
    lines.push(`llm calls  : ${String(r.ledger.total.callCount)}`);
    lines.push(
      `llm tokens : in=${String(r.ledger.total.input)} out=${String(r.ledger.total.output)}`,
    );
  }
  return lines.join('\n');
}
