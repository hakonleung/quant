import type { SocketEnvelope, SocketTopic } from '@quant/shared';

import { SocketBus, type SocketSink } from '../../../src/modules/socket/socket-bus.service.js';

class FakeSink implements SocketSink {
  published: Array<{ topic: SocketTopic; envelope: SocketEnvelope }> = [];
  publish(topic: SocketTopic, envelope: SocketEnvelope): void {
    this.published.push({ topic, envelope });
  }
}

describe('SocketBus', () => {
  it('publishes a validated payload to the gateway', () => {
    const bus = new SocketBus();
    const sink = new FakeSink();
    bus.setSink(sink);

    bus.emit('queue.snapshot', {
      ts: '2026-05-04T01:00:00Z',
      queues: [{ name: 'meta', pending: 1, inFlight: 0, paused: false }],
      activeScans: [],
    });

    expect(sink.published).toHaveLength(1);
    expect(sink.published[0]?.topic).toBe('queue.snapshot');
    expect(sink.published[0]?.envelope.topic).toBe('queue.snapshot');
    expect(sink.published[0]?.envelope.payload).toMatchObject({ queues: [{ name: 'meta' }] });
  });

  it('drops invalid payloads instead of pushing them', () => {
    const bus = new SocketBus();
    const sink = new FakeSink();
    bus.setSink(sink);

    bus.emit('queue.snapshot', { ts: 'not-iso', queues: [], activeScans: [] } as never);
    expect(sink.published).toHaveLength(0);
  });

  it('drops emits when no sink is registered (boot order)', () => {
    const bus = new SocketBus();
    expect(() =>
      bus.emit('queue.snapshot', {
        ts: '2026-05-04T01:00:00Z',
        queues: [],
        activeScans: [],
      }),
    ).not.toThrow();
  });
});
