/**
 * Backend instruction handler port. Each feature module provides a
 * concrete `InstructionHandler` and registers it via
 * `provideInstructionHandler(spec, useClass)` in its module providers.
 *
 * Handlers must be deterministic on `(args, ctx)` — any external IO is
 * an injected service. They throw nothing on validation: every error
 * surfaced to the user is encoded as `{ ok: false, error }`. Throws are
 * caught by the executor and reported as `{ code: 'handler' }`.
 */

import type { ChannelId, InstructionResult } from '@quant/shared';

export type InstructionSource = 'im' | 'socket' | 'http';

export interface InstructionCtx {
  readonly traceId: string;
  readonly source: InstructionSource;
  /** Inbound IM source channel (slack / feishu); absent for socket/http. */
  readonly channelId?: ChannelId;
  /** `<channel>:<user_id>` of the IM sender. */
  readonly sender?: string;
  /** Slack channel id / Feishu chat id where the reply should land. */
  readonly target?: string;
  /** Resolved internal userId for per-user data scoping. Always set by callers. */
  readonly userId: string;
  /** True when the user has only ever been seen via IM, never Web OAuth. */
  readonly imBootstrap?: boolean;
}

export interface InstructionHandler<TArgs> {
  execute(args: TArgs, ctx: InstructionCtx): Promise<InstructionResult>;
}

export type AnyInstructionHandler = InstructionHandler<unknown>;
