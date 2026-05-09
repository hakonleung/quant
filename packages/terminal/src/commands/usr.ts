/**
 * `usr` — show the caller's resolved identity, role, and admin mapping.
 *
 * Mirrors the `/usr` IM/socket instruction (apps/api/.../usr.handler.ts)
 * so the terminal user has the same diagnostic surface available without
 * leaving the workbench. Pure read; no args.
 */

import { userMeAction } from '../actions/registry.js';
import type { CommandSpec } from '../registry.js';
import { textErr, textOk } from '../widgets/helpers.js';

export const usrCommand: CommandSpec = {
  name: 'usr',
  summary: 'Show resolved userId, role, source, and admin mapping (if any).',
  async run(_argv, ctx) {
    try {
      const { data } = await ctx.actions.run(userMeAction, {}, { signal: ctx.signal });
      const lines: string[] = [
        `user_id    : ${data.userId}`,
        `display    : ${data.displayName}`,
        `role       : ${data.role}`,
        `source     : ${data.source}`,
      ];
      if (data.originalUserId !== undefined) {
        lines.push(`mapped_from: ${data.originalUserId} (AUTH_ADMIN_USER_IDS)`);
      }
      if (data.imBootstrap) {
        lines.push('bootstrap  : true (no Web login yet)');
      }
      return textOk(lines.join('\n'));
    } catch (err) {
      return textErr(err instanceof Error ? err.message : String(err));
    }
  },
};
