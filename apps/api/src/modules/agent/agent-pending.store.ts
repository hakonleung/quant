/**
 * Pause-and-resume snapshots for the `/agent` loop.
 *
 * When the LLM proposes any tool call that is `costsCredits` /
 * `destructive`, the loop emits an `instruction.agent.delta` `confirm`
 * frame and parks the in-flight state under a fresh `correlationId`.
 * The user's "approve" / "cancel" reply (term widget submit, Feishu
 * button callback) hands `correlationId` back, and `agent-confirm` lifts
 * the snapshot from here to resume.
 *
 * In-memory only; entries TTL out at 5 minutes. A v2 with a persistent
 * backend is straightforward but not needed yet.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ServerConfigCenter } from '@quant/config/server';
import type { ChatMessage, ChatTokenUsage, ChatToolCall } from '@quant/shared';
import { randomUUID } from 'node:crypto';

import type { AgentDeliveryTarget } from './agent.types.js';

export interface AgentPendingSnapshot {
  readonly userId: string;
  readonly traceId: string;
  readonly jobId: string;
  /** Where the resumed loop should send `instruction.agent.delta` frames. */
  readonly delivery: AgentDeliveryTarget;
  /** Conversation as built by the loop up to (and including) the `tool_calls` round. */
  readonly messages: readonly ChatMessage[];
  /** Tool calls awaiting user approval. */
  readonly toolCalls: readonly ChatToolCall[];
  /** Cumulative usage so the `done` frame can include the full session total. */
  readonly usageAcc: ChatTokenUsage;
  /** Number of tool calls executed before the pause — also surfaced in `done`. */
  readonly toolCallCount: number;
  /** Step ceiling (`maxToolCalls`) the loop was honouring. */
  readonly maxToolCalls: number;
  /** Step the loop will resume on (zero-based). */
  readonly resumeStep: number;
}

interface Slot {
  readonly snapshot: AgentPendingSnapshot;
  readonly expiresAt: number;
}

@Injectable()
export class AgentPendingStore {
  private readonly logger = new Logger(AgentPendingStore.name);
  private readonly slots = new Map<string, Slot>();
  private readonly sweepTimer: NodeJS.Timeout;
  private readonly defaultTtlMs: number;

  constructor() {
    const cfg = ServerConfigCenter.get().cache.agentPending;
    this.defaultTtlMs = cfg.defaultTtlMs;
    this.sweepTimer = setInterval(() => this.sweep(), cfg.sweepIntervalMs);
    // Don't keep the process alive solely to sweep an empty map.
    this.sweepTimer.unref?.();
  }

  /** Park `snapshot` under a fresh `correlationId`. Returns the id. */
  put(snapshot: AgentPendingSnapshot, ttlMs?: number): string {
    const effectiveTtl = ttlMs ?? this.defaultTtlMs;
    const correlationId = randomUUID();
    this.slots.set(correlationId, { snapshot, expiresAt: Date.now() + effectiveTtl });
    return correlationId;
  }

  /** Lift the snapshot, removing it. Returns `null` when expired / unknown. */
  take(correlationId: string): AgentPendingSnapshot | null {
    const slot = this.slots.get(correlationId);
    if (slot === undefined) return null;
    this.slots.delete(correlationId);
    if (slot.expiresAt < Date.now()) {
      this.logger.warn(`agent_pending_expired correlationId=${correlationId}`);
      return null;
    }
    return slot.snapshot;
  }

  /** Used by the `/agent` confirm flow when the user explicitly cancels. */
  drop(correlationId: string): void {
    this.slots.delete(correlationId);
  }

  size(): number {
    return this.slots.size;
  }

  /** Test seam — tear down the sweeper. */
  shutdown(): void {
    clearInterval(this.sweepTimer);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, slot] of this.slots) {
      if (slot.expiresAt < now) this.slots.delete(id);
    }
  }
}
