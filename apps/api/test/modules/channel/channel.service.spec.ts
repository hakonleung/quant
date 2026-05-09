import type { ChannelActivity, ChannelId } from '@quant/shared';

import {
  ChannelBus,
  type OutboundJob,
} from '../../../src/modules/channel/bus/channel-bus.service.js';
import { ChannelRegistry } from '../../../src/modules/channel/channel.registry.js';
import { ChannelService } from '../../../src/modules/channel/channel.service.js';

class FakeRegistry {
  enabled: ChannelId[] = ['slack', 'feishu'];
  ids(): readonly ChannelId[] {
    return this.enabled;
  }
}

class FakeBus {
  activities: ChannelActivity[] = [];
  jobs: OutboundJob[] = [];
  publishActivity(a: ChannelActivity): void {
    this.activities.push(a);
  }
  async enqueueOutbound(j: OutboundJob): Promise<void> {
    this.jobs.push(j);
  }
}

function makeService(): { svc: ChannelService; reg: FakeRegistry; bus: FakeBus } {
  const reg = new FakeRegistry();
  const bus = new FakeBus();
  const svc = new ChannelService(reg as unknown as ChannelRegistry, bus as unknown as ChannelBus);
  return { svc, reg, bus };
}

describe('ChannelService.broadcast', () => {
  it('fans out to every enabled channel by default', async () => {
    const { svc, bus } = makeService();
    const res = await svc.broadcast(
      { text: 'hello', kind: 'manual' },
      { traceId: 't-1', source: 'manual' },
    );
    expect(res.accepted).toEqual(['slack', 'feishu']);
    expect(bus.jobs).toHaveLength(2);
    expect(bus.activities).toHaveLength(2);
    expect(bus.activities[0]?.status).toBe('pending');
  });

  it('limits fan-out to the requested subset, intersected with enabled', async () => {
    const { svc, bus } = makeService();
    const res = await svc.broadcast(
      { text: 'hello', kind: 'manual', channels: ['slack'] },
      { traceId: 't-2', source: 'manual' },
    );
    expect(res.accepted).toEqual(['slack']);
    expect(bus.jobs).toHaveLength(1);
    expect(bus.jobs[0]?.channel).toBe('slack');
  });

  it('drops channels that are not enabled at runtime', async () => {
    const { svc, reg, bus } = makeService();
    reg.enabled = ['slack'];
    const res = await svc.broadcast(
      { text: 'hello', kind: 'manual', channels: ['slack', 'feishu'] },
      { traceId: 't-3', source: 'system' },
    );
    expect(res.accepted).toEqual(['slack']);
    expect(bus.jobs).toHaveLength(1);
  });

  it('preserves title + meta on the pending activity row and on the job', async () => {
    const { svc, bus } = makeService();
    await svc.broadcast(
      { text: 'body', kind: 'watch.hit', title: 'HIT', meta: { code: '600000' } },
      { traceId: 't-4', source: 'system' },
    );
    expect(bus.activities[0]?.title).toBe('HIT');
    expect(bus.activities[0]?.meta).toEqual({ code: '600000' });
    expect(bus.jobs[0]?.message.title).toBe('HIT');
    expect(bus.jobs[0]?.message.meta).toEqual({ code: '600000' });
  });
});
