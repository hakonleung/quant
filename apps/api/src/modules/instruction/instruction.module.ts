/**
 * Global instruction module — composition root for the registry, the
 * executor, the IM listener, and the built-in handlers (help / ping /
 * channel-echo). Feature modules supply their own handlers and import
 * this module implicitly via the @Global() flag.
 *
 * Imports `ChannelModule` so the IM listener can call
 * `ChannelService.send` for replies.
 */

import { BullModule } from '@nestjs/bullmq';
import { Global, Module, forwardRef } from '@nestjs/common';

import { SYSTEM_CLOCK_PROVIDER } from '../../common/clock.js';
import { ChannelModule } from '../channel/channel.module.js';

import { INSTRUCTION_ASYNC_QUEUE, InstructionAsyncBus } from './async/instruction-async.bus.js';
import { InstructionAsyncProcessor } from './async/instruction-async.processor.js';
import { ChannelEchoHandler } from './handlers/channel-echo.handler.js';
import { HelpHandler } from './handlers/help.handler.js';
import { PingHandler } from './handlers/ping.handler.js';
import { UsrHandler } from './handlers/usr.handler.js';
import { INSTRUCTION_CONFIG, loadInstructionConfig } from './instruction.config.js';
import { InstructionExecutor } from './instruction.executor.js';
import { InstructionImListener } from './instruction.im.listener.js';
import { InstructionRegistry } from './instruction.registry.js';
import { SocketInstructionAdapter } from './socket-instruction.adapter.js';

@Global()
@Module({
  imports: [
    forwardRef((): typeof ChannelModule => ChannelModule),
    BullModule.registerQueue({ name: INSTRUCTION_ASYNC_QUEUE }),
  ],
  providers: [
    SYSTEM_CLOCK_PROVIDER,
    {
      provide: INSTRUCTION_CONFIG,
      useFactory: () => loadInstructionConfig(),
    },
    InstructionRegistry,
    InstructionAsyncBus,
    InstructionAsyncProcessor,
    InstructionExecutor,
    InstructionImListener,
    SocketInstructionAdapter,
    HelpHandler,
    PingHandler,
    ChannelEchoHandler,
    UsrHandler,
  ],
  exports: [
    INSTRUCTION_CONFIG,
    InstructionRegistry,
    InstructionExecutor,
    InstructionAsyncBus,
    SocketInstructionAdapter,
  ],
})
export class InstructionModule {}
