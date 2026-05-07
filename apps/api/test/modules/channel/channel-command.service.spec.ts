import type {
  ChannelOutboundRequest,
  ChannelOutboundResponse,
  SocketCommand,
} from '@quant/shared';

import { ChannelCommandService } from '../../../src/modules/channel/channel-command.service.js';
import type { ChannelService } from '../../../src/modules/channel/channel.service.js';

class FakeChannelService {
  calls: Array<{ channel: string; req: ChannelOutboundRequest }> = [];
  async send(channel: string, req: ChannelOutboundRequest): Promise<ChannelOutboundResponse> {
    this.calls.push({ channel, req });
    return { accepted: [channel as 'slack'], activityIds: ['a1'] };
  }
  async broadcast(): Promise<ChannelOutboundResponse> {
    return { accepted: [], activityIds: [] };
  }
}

describe('ChannelCommandService', () => {
  it('routes channel.send to the underlying service and returns ok', async () => {
    const fake = new FakeChannelService();
    const svc = new ChannelCommandService(fake as unknown as ChannelService);
    const cmd: SocketCommand = { kind: 'channel.send', channel: 'slack', text: 'hi' };
    const ack = await svc.handle(cmd, 'trace-1');
    expect(ack.ok).toBe(true);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.channel).toBe('slack');
    expect(fake.calls[0]?.req.text).toBe('hi');
  });

  it('passes target override through', async () => {
    const fake = new FakeChannelService();
    const svc = new ChannelCommandService(fake as unknown as ChannelService);
    await svc.handle(
      { kind: 'channel.send', channel: 'feishu', text: 'hi', target: 'oc_123' },
      'trace-2',
    );
    expect(fake.calls[0]?.req.target).toBe('oc_123');
  });

  it('responds to ping with the echoed payload', async () => {
    const fake = new FakeChannelService();
    const svc = new ChannelCommandService(fake as unknown as ChannelService);
    const ack = await svc.handle({ kind: 'ping', payload: 'hello' }, 'trace-3');
    expect(ack.ok).toBe(true);
    expect(ack.detail).toEqual({ pong: 'hello' });
  });

  it('returns ok=false when the underlying service accepts no channels', async () => {
    const fake = {
      send: async () => ({ accepted: [], activityIds: [] }),
      broadcast: async () => ({ accepted: [], activityIds: [] }),
    };
    const svc = new ChannelCommandService(fake as unknown as ChannelService);
    const ack = await svc.handle({ kind: 'channel.send', channel: 'slack', text: 'hi' }, 't');
    expect(ack.ok).toBe(false);
  });
});
