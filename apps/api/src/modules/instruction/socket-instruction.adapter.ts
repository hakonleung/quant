/**
 * Adapts `InstructionExecutor` to the `SocketCommandHandler` port the
 * socket gateway depends on. Lives in the instruction module so the
 * socket module stays decoupled from individual handler classes.
 */

import { Inject, Injectable } from '@nestjs/common';
import { formatResult, type SocketCommand, type SocketCommandAck } from '@quant/shared';

import type { SocketCommandHandler } from '../socket/socket.gateway.js';

import { InstructionExecutor } from './instruction.executor.js';

@Injectable()
export class SocketInstructionAdapter implements SocketCommandHandler {
  constructor(@Inject(InstructionExecutor) private readonly executor: InstructionExecutor) {}

  async handle(command: SocketCommand, traceId: string): Promise<SocketCommandAck> {
    const result = await this.executor.execute(command.id, command.args, {
      traceId,
      source: 'socket',
    });
    if (result.ok) {
      return { ok: true, detail: { text: result.output.text } };
    }
    return {
      ok: false,
      error: result.error.code,
      detail: { text: formatResult(result), code: result.error.code, message: result.error.message },
    };
  }
}
