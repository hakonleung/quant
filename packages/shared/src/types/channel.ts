/**
 * Cross-process contract for the channel module
 * (`docs/modules/11-channel.md`). Replaces the legacy `push.ts` shapes
 * with a multi-IM (slack / feishu) outbound + inbound surface.
 *
 * `ChannelActivity` is the row pushed onto the realtime socket bus
 * (`channel.activity` topic) so the frontend `feat-channel` feed renders
 * both system pushes and inbound IM messages in one virtualized list.
 */

import { z } from 'zod';

export const ChannelIdSchema = z.enum(['slack', 'feishu']);
export type ChannelId = z.infer<typeof ChannelIdSchema>;

/**
 * Why an outbound message exists. `system` covers any backend-initiated
 * notification (watch hits, scan failures, scheduled summaries);
 * `manual` is a human-triggered ad-hoc send (e.g. POST /api/channel/send).
 */
export const ChannelMessageSourceSchema = z.enum(['system', 'manual', 'inbound']);
export type ChannelMessageSource = z.infer<typeof ChannelMessageSourceSchema>;

export const ChannelOutboundRequestSchema = z
  .object({
    channels: z.array(ChannelIdSchema).min(1).optional(),
    text: z.string().min(1).max(16000),
    title: z.string().max(280).optional(),
    /** Logical category — surfaces in the FE feed as a chip. */
    kind: z.string().min(1).max(64).default('manual'),
    /** Optional override (e.g. Slack channel id, Feishu chat id). */
    target: z.string().min(1).max(256).optional(),
    /** Free-form metadata; persisted in the activity row. */
    meta: z.record(z.unknown()).optional(),
  })
  .strict();
export type ChannelOutboundRequest = z.infer<typeof ChannelOutboundRequestSchema>;

export const ChannelDeliveryStatusSchema = z.enum(['pending', 'sent', 'failed', 'dryrun']);
export type ChannelDeliveryStatus = z.infer<typeof ChannelDeliveryStatusSchema>;

/**
 * Single row in the unified activity feed. Covers:
 *   - outbound system push (kind=`watch.hit`, source=`system`, status=sent/dryrun)
 *   - outbound manual send  (source=`manual`)
 *   - inbound IM event       (source=`inbound`, channel=slack/feishu)
 */
export const ChannelActivitySchema = z
  .object({
    id: z.string().min(1),
    ts: z.string().datetime({ offset: true }),
    channel: ChannelIdSchema,
    source: ChannelMessageSourceSchema,
    /** Logical category, e.g. `watch.hit`, `manual`, `inbound.message`. */
    kind: z.string().min(1).max(64),
    text: z.string().max(16000),
    title: z.string().max(280).optional(),
    /** Outbound only: delivery state. Inbound rows omit this field. */
    status: ChannelDeliveryStatusSchema.optional(),
    /** Slack channel id, Feishu chat id, or "(dry-run)" when no creds. */
    target: z.string().optional(),
    /** Inbound only: who sent the message, in `<channel>:<user_id>` form. */
    sender: z.string().optional(),
    error: z.string().optional(),
    traceId: z.string().min(1),
    meta: z.record(z.unknown()).optional(),
  })
  .strict();
export type ChannelActivity = z.infer<typeof ChannelActivitySchema>;

export const ChannelStatusSchema = z
  .object({
    id: ChannelIdSchema,
    enabled: z.boolean(),
    /** True when secrets are present *and* the inbound subscriber is up. */
    ready: z.boolean(),
    inbound: z.boolean(),
    detail: z.string().optional(),
  })
  .strict();
export type ChannelStatus = z.infer<typeof ChannelStatusSchema>;

export const ChannelOutboundResponseSchema = z
  .object({
    accepted: z.array(ChannelIdSchema),
    activityIds: z.array(z.string().min(1)),
  })
  .strict();
export type ChannelOutboundResponse = z.infer<typeof ChannelOutboundResponseSchema>;
