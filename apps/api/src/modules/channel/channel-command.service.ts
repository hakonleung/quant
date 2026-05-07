/**
 * Implementation of `SocketCommandHandler` (apps/api/src/modules/socket).
 *
 * Today we only handle:
 *   - `channel.send` — manual outbound from a frontend command.
 *   - `ping`        — round-trip latency probe used by the FE socket
 *                     client's connection health check.
 *
 * New commands are added here (and registered in the shared
 * `SocketCommandSchema` discriminated union). Each branch must be
 * exhaustive — TypeScript catches missing cases.
 */

import { Inject, Injectable } from '@nestjs/common';
import type { SocketCommand, SocketCommandAck } from '@quant/shared';

import type { SocketCommandHandler } from '../socket/socket.gateway.js';
import { ChannelService } from './channel.service.js';

@Injectable()
export class ChannelCommandService implements SocketCommandHandler {
  constructor(@Inject(ChannelService) private readonly channels: ChannelService) {}

  async handle(command: SocketCommand, traceId: string): Promise<SocketCommandAck> {
    switch (command.kind) {
      case 'channel.send': {
        const res = await this.channels.send(
          command.channel,
          {
            text: command.text,
            kind: 'manual',
            ...(command.target !== undefined ? { target: command.target } : {}),
          },
          { traceId, source: 'manual' },
        );
        return { ok: res.accepted.length > 0, detail: res };
      }
      case 'ping':
        return { ok: true, detail: { pong: command.payload ?? '' } };
    }
  }
}
