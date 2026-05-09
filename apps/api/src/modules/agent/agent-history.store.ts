/**
 * Per-user × per-channel rolling history of IM messages, used by the
 * `/agent` instruction to inject recent context into the LLM prompt.
 *
 * Two write paths:
 *   1. Subscribed to `CHANNEL_INBOUND_EVENT` — every IM message the
 *      user sends lands here as `role: 'user'` automatically.
 *   2. The agent service appends `role: 'assistant'` entries with the
 *      final answer text after each loop completes, so the next round
 *      sees what the agent has already said.
 *
 * Storage is in-memory (Map keyed by `${userId}|${channel}`) — sized
 * by `MAX_ENTRIES_PER_KEY` per slot, evicted by LRU at the slot level
 * when total user count exceeds `MAX_USERS`. Persistence is a v2
 * concern; restart loses recent context, which is acceptable for v1.
 */

import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import type { AgentHistoryEntry, ChannelId } from '@quant/shared';

import { CHANNEL_INBOUND_EVENT } from '../channel/bus/channel-bus.service.js';
import type { InboundMessage } from '../channel/ports/channel-adapter.port.js';
import { AuthService } from '../auth/auth.service.js';

const MAX_ENTRIES_PER_KEY = 32;
const MAX_USERS = 256;

interface Slot {
  readonly entries: AgentHistoryEntry[];
  lastTouchedAt: number;
}

@Injectable()
export class AgentHistoryStore {
  private readonly logger = new Logger(AgentHistoryStore.name);
  private readonly slots = new Map<string, Slot>();

  constructor(private readonly auth: AuthService) {}

  @OnEvent(CHANNEL_INBOUND_EVENT)
  async onInbound(msg: InboundMessage): Promise<void> {
    try {
      const user = await this.auth.resolveFromImChannel(msg.channel, msg.sender);
      this.append(user.id, msg.channel, {
        role: 'user',
        content: msg.text,
        ts: msg.receivedAt,
      });
    } catch (err) {
      // History capture must never break the inbound listener.
      this.logger.warn(
        `agent_history_capture_failed channel=${msg.channel} sender=${msg.sender} err=${String(err)}`,
      );
    }
  }

  /**
   * Append a single entry. Used by `onInbound` for inbound user
   * messages and by the agent service for the assistant's reply.
   */
  append(userId: string, channel: ChannelId, entry: AgentHistoryEntry): void {
    const key = makeKey(userId, channel);
    let slot = this.slots.get(key);
    if (slot === undefined) {
      slot = { entries: [], lastTouchedAt: Date.now() };
      this.slots.set(key, slot);
    } else {
      slot.lastTouchedAt = Date.now();
    }
    slot.entries.push(entry);
    if (slot.entries.length > MAX_ENTRIES_PER_KEY) {
      slot.entries.splice(0, slot.entries.length - MAX_ENTRIES_PER_KEY);
    }
    this.evictIfOverflow();
  }

  /** Last `n` entries for the given (userId, channel) slot, oldest first. */
  recent(userId: string, channel: ChannelId, n = 10): readonly AgentHistoryEntry[] {
    const slot = this.slots.get(makeKey(userId, channel));
    if (slot === undefined) return [];
    slot.lastTouchedAt = Date.now();
    if (n >= slot.entries.length) return [...slot.entries];
    return slot.entries.slice(-n);
  }

  /** Drop a slot — used by tests / `/usr reset` (when added). */
  clear(userId: string, channel: ChannelId): void {
    this.slots.delete(makeKey(userId, channel));
  }

  /** Number of active slots — exposed for tests / metrics. */
  size(): number {
    return this.slots.size;
  }

  private evictIfOverflow(): void {
    if (this.slots.size <= MAX_USERS) return;
    const sorted = Array.from(this.slots.entries()).sort(
      (a, b) => a[1].lastTouchedAt - b[1].lastTouchedAt,
    );
    while (this.slots.size > MAX_USERS && sorted.length > 0) {
      const next = sorted.shift();
      if (next === undefined) break;
      this.slots.delete(next[0]);
    }
  }
}

function makeKey(userId: string, channel: ChannelId): string {
  return `${userId}|${channel}`;
}
