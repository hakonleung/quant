/**
 * Global instruction module — composition root for the registry, the
 * executor, the IM listener, and the built-in handlers (help / ping /
 * channel-echo). Feature modules supply their own handlers and import
 * this module implicitly via the @Global() flag.
 *
 * Imports `ChannelModule` so the IM listener can call
 * `ChannelService.send` for replies.
 */

import { Global, Module, forwardRef } from '@nestjs/common';

import { ChannelModule } from '../channel/channel.module.js';

import { ChannelEchoHandler } from './handlers/channel-echo.handler.js';
import { HelpHandler } from './handlers/help.handler.js';
import { PingHandler } from './handlers/ping.handler.js';
import { InstructionExecutor } from './instruction.executor.js';
import { InstructionImListener } from './instruction.im.listener.js';
import { InstructionRegistry } from './instruction.registry.js';
import { SocketInstructionAdapter } from './socket-instruction.adapter.js';

@Global()
@Module({
  imports: [forwardRef((): typeof ChannelModule => ChannelModule)],
  providers: [
    InstructionRegistry,
    InstructionExecutor,
    InstructionImListener,
    SocketInstructionAdapter,
    HelpHandler,
    PingHandler,
    ChannelEchoHandler,
  ],
  exports: [InstructionRegistry, InstructionExecutor, SocketInstructionAdapter],
})
export class InstructionModule {}
