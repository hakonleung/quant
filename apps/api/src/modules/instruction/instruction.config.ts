/**
 * Module-local config for the instruction subsystem.
 *
 *   - `INSTRUCTION_IM_ALLOWLIST` — comma-separated sender ids
 *     (e.g. `feishu:ou_abc,slack:U_xyz`). Empty / unset = full open
 *     (back-compat with v1; **prod must set this**).
 *   - `INSTRUCTION_DEBUG_ENABLED` — when true, the dev-only handlers
 *     (`ping`, `channel.echo`, `channel.send`) self-register. Defaults to
 *     false so the production IM surface only exposes business
 *     instructions (`stock` / `sector` / `analyze` / `watch` / `ledger` /
 *     `screen` / `update` / `help`).
 *
 * The loader is a plain function (not a Nest class) so it can run before
 * the DI container is up and so unit tests can call it with a stub env.
 */

import { z } from 'zod';

export const INSTRUCTION_CONFIG = Symbol('INSTRUCTION_CONFIG');

const BOOL_TRUE = new Set(['1', 'true', 'TRUE', 'yes', 'on']);
const BOOL_FALSE = new Set(['', '0', 'false', 'FALSE', 'no', 'off']);

const rawSchema = z
  .object({
    imAllowlist: z.string().default(''),
    debugInstructionsEnabled: z.string().default(''),
  })
  .strict();

export interface InstructionConfig {
  readonly imAllowlist: ReadonlySet<string>;
  readonly debugInstructionsEnabled: boolean;
}

function parseBool(raw: string, key: string): boolean {
  if (BOOL_TRUE.has(raw)) return true;
  if (BOOL_FALSE.has(raw)) return false;
  throw new Error(`invalid boolean for ${key}: ${raw}`);
}

function parseList(raw: string): ReadonlySet<string> {
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

export function loadInstructionConfig(env: NodeJS.ProcessEnv = process.env): InstructionConfig {
  const raw = rawSchema.parse({
    imAllowlist: env['INSTRUCTION_IM_ALLOWLIST'] ?? '',
    debugInstructionsEnabled: env['INSTRUCTION_DEBUG_ENABLED'] ?? '',
  });
  return {
    imAllowlist: parseList(raw.imAllowlist),
    debugInstructionsEnabled: parseBool(raw.debugInstructionsEnabled, 'INSTRUCTION_DEBUG_ENABLED'),
  };
}
