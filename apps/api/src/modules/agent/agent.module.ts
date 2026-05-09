/**
 * Composition root for the `/agent` feature.
 *
 * Depends on:
 *   - `LlmModule` (global) for chat-completion + streaming.
 *   - `InstructionModule` for the registry + executor (tool dispatch).
 *   - `ChannelModule` for IM delivery + `AuthService` (history capture).
 *   - `SocketModule` for the realtime delta stream.
 */

import { Module } from '@nestjs/common';

import { SYSTEM_CLOCK_PROVIDER } from '../../common/clock.js';
import { AuthModule } from '../auth/auth.module.js';
import { ChannelModule } from '../channel/channel.module.js';
import { InstructionModule } from '../instruction/instruction.module.js';
import { SocketModule } from '../socket/socket.module.js';
import { AgentHistoryStore } from './agent-history.store.js';
import { AgentPendingStore } from './agent-pending.store.js';
import { AgentService } from './agent.service.js';
import { AgentToolBridge } from './agent-tool-bridge.js';
import { AgentConfirmInstructionHandler } from './instructions/agent-confirm.handler.js';
import { AgentInstructionHandler } from './instructions/agent.handler.js';

@Module({
  imports: [
    AuthModule,
    ChannelModule,
    InstructionModule,
    SocketModule.forRoot({ imports: [InstructionModule] }),
  ],
  providers: [
    SYSTEM_CLOCK_PROVIDER,
    AgentToolBridge,
    AgentHistoryStore,
    AgentPendingStore,
    AgentService,
    AgentInstructionHandler,
    AgentConfirmInstructionHandler,
  ],
  exports: [AgentService, AgentHistoryStore],
})
export class AgentModule {}
