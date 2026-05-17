/**
 * Composition root for the `/agent` feature.
 *
 * Depends on:
 *   - `LlmModule` (global) for chat-completion + streaming.
 *   - `InstructionModule` for the registry + executor (tool dispatch).
 *     Wrapped in `forwardRef` because the cycle
 *     `AgentModule → InstructionModule → InstructionCenterModule → AgentModule`
 *     trips ES-modules TDZ at evaluation time without it — the
 *     callback delays the `InstructionModule` symbol read until after
 *     ESM evaluation finishes, while Nest still sees the edge in its
 *     module graph.
 *   - `ChannelModule` for IM delivery + `AuthService` (history capture).
 *   - `SocketModule` for the realtime delta stream.
 */

import { Module, forwardRef } from '@nestjs/common';

import { SYSTEM_CLOCK_PROVIDER } from '../../common/clock.js';
import { AuthModule } from '../auth/auth.module.js';
import { ChannelModule } from '../channel/channel.module.js';
import { InstructionModule } from '../instruction/instruction.module.js';
import { SocketModule } from '../socket/socket.module.js';
import { AgentHistoryStore } from './agent-history.store.js';
import { AgentImDelivery } from './agent-im-delivery.js';
import { AgentPendingStore } from './agent-pending.store.js';
import { AgentService } from './agent.service.js';
import { AGENT_CONFIG, loadAgentConfig } from './agent.config.js';
import { AgentStreamFinalizer } from './agent-stream-finalizer.js';
import { AgentToolBridge } from './agent-tool-bridge.js';

@Module({
  imports: [
    AuthModule,
    ChannelModule,
    forwardRef((): typeof InstructionModule => InstructionModule),
    SocketModule.forRoot({
      imports: [forwardRef((): typeof InstructionModule => InstructionModule)],
    }),
  ],
  providers: [
    {
      provide: AGENT_CONFIG,
      useFactory: () => loadAgentConfig(),
    },
    SYSTEM_CLOCK_PROVIDER,
    AgentToolBridge,
    AgentHistoryStore,
    AgentImDelivery,
    AgentPendingStore,
    AgentStreamFinalizer,
    AgentService,
    // `agent` / `agent.confirm` / `web.search` migrated to
    // `BeInstructionCenter` (instruction-center/cells/agent*.cell.ts,
    // cells/web-search.cell.ts).
  ],
  exports: [AgentService, AgentHistoryStore, AgentPendingStore],
})
export class AgentModule {}
