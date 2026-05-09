/**
 * Internal agent-module types — kept out of the @Global LlmModule + the
 * shared package because they only matter to this module's surface.
 */

import type { ChannelId } from '@quant/shared';

/**
 * Where the agent loop ships its `instruction.agent.delta` frames + the
 * final result card. The agent service writes to the matching transport
 * via `SocketBus.emitTo` (term) and/or `ChannelService.send` (IM).
 */
export type AgentDeliveryTarget =
  | { readonly kind: 'socket'; readonly userId: string }
  | {
      readonly kind: 'im';
      readonly channel: ChannelId;
      readonly target: string;
      readonly userId: string;
    };
