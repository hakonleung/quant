'use client';

/**
 * Module-level singleton subscriber for the `channel.activity` topic.
 *
 * Call `startChannelActivitySubscription()` once from the app shell
 * (e.g. RemoteSyncBoot). Subsequent calls are no-ops. The subscription
 * lives for the page lifetime — no unsubscribe, because the data should
 * persist across component mount/unmount cycles.
 */

import { ChannelActivitySchema } from '@quant/shared';

import { useChannelActivityStore } from '../stores/channel-activity.store.js';
import { subscribeTopic } from './socket-client.js';

let started = false;

export function startChannelActivitySubscription(): void {
  if (started) return;
  started = true;

  subscribeTopic('channel.activity', (payload) => {
    const parsed = ChannelActivitySchema.safeParse(payload);
    if (!parsed.success) {
      useChannelActivityStore.getState().setStatus('error', parsed.error.message);
      return;
    }
    useChannelActivityStore.getState().pushActivity(parsed.data);
  });
}
