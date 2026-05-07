/**
 * Socket module — owns the realtime gateway and exposes `SocketBus` so
 * other modules can publish without depending on Socket.IO directly.
 *
 * `SOCKET_COMMAND_HANDLER` is the port other modules (currently `channel`)
 * implement to handle FE → BE commands. App composition root wires the
 * concrete handler via `SocketModule.forRoot({ commandHandler: ... })`
 * so the gateway can dispatch without a circular import.
 *
 * Marked `@Global()` because most feature modules need to inject
 * `SocketBus` to publish snapshots; importing the module in every
 * feature would be noise.
 */

import {
  Global,
  Module,
  type DynamicModule,
  type ForwardReference,
  type Provider,
  type Type,
} from '@nestjs/common';

import {
  SocketGateway,
  SOCKET_COMMAND_HANDLER,
  type SocketCommandHandler,
} from './socket.gateway.js';
import { SocketBus } from './socket-bus.service.js';

class NoopCommandHandler implements SocketCommandHandler {
  async handle(): Promise<{ ok: boolean; error: string }> {
    return { ok: false, error: 'no_command_handler_registered' };
  }
}

interface SocketModuleOptions {
  /** Module(s) that export the command-handler provider. */
  readonly imports?: readonly (Type<unknown> | DynamicModule | ForwardReference)[];
  /** Class token for the command handler; must be exported by `imports`. */
  readonly commandHandler?: Type<SocketCommandHandler>;
}

const baseProviders: Provider[] = [SocketBus, SocketGateway];

@Global()
@Module({
  providers: [...baseProviders, { provide: SOCKET_COMMAND_HANDLER, useClass: NoopCommandHandler }],
  exports: [SocketBus],
})
export class SocketModule {
  static forRoot(options: SocketModuleOptions): DynamicModule {
    const handlerProvider: Provider =
      options.commandHandler !== undefined
        ? { provide: SOCKET_COMMAND_HANDLER, useExisting: options.commandHandler }
        : { provide: SOCKET_COMMAND_HANDLER, useClass: NoopCommandHandler };
    return {
      module: SocketModule,
      global: true,
      imports: options.imports !== undefined ? [...options.imports] : [],
      providers: [...baseProviders, handlerProvider],
      exports: [SocketBus],
    };
  }
}
