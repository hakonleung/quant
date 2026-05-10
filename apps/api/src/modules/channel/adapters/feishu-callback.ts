/**
 * Feishu Card Request URL callback decoding helpers.
 *
 * Owns the three concerns the HTTP /api/channel/feishu/card endpoint
 * needs to know about, but that don't belong inside the IM-channel
 * adapter class itself:
 *
 *   1. Optional AES-256-CBC decryption when the Feishu app has an
 *      Encrypt Key configured (`maybeDecrypt`).
 *   2. Optional SHA-1 / SHA-256 signature verification when the app
 *      has a Verification Token configured (`verifySignature`).
 *   3. Schema 1.0 / 2.0 envelope narrowing into a strict
 *      `Lark.RawCardActionEvent` shape (`extractCardEvent`).
 *
 * Pulled out of `feishu.adapter.ts` to keep that file under the
 * 400-LoC cap (CLAUDE.md §1.2). All exports are stateless pure
 * functions — they take config + logger fields rather than holding any
 * adapter state — so they are trivially testable in isolation.
 */

import * as Lark from '@larksuiteoapi/node-sdk';
import * as crypto from 'node:crypto';
import { z } from 'zod';

export interface FeishuCallbackKeys {
  /** AES key for encrypted callbacks; null when the app uses plain payloads. */
  readonly encryptKey: string | null;
  /** Verification token used by the SHA-1 signature on schema-1 callbacks. */
  readonly verificationToken: string | null;
}

export interface CallbackLogger {
  warn(message: string): void;
}

/**
 * URL-verification probe Feishu sends when registering the callback URL.
 * Echoed back as `{ challenge }`.
 */
export const challengeSchema = z.object({
  type: z.literal('url_verification'),
  challenge: z.string(),
  token: z.string().optional(),
});

/**
 * Outer envelope of a schema-2.0 (card-kit-v2) callback. The inner
 * `event` itself is a schema-1-shaped flat payload.
 */
export const schema2Envelope = z.object({
  schema: z.string(),
  header: z.record(z.unknown()).optional(),
  event: z.record(z.unknown()),
});

/**
 * Minimal subset of {@link Lark.RawCardActionEvent} that
 * `Lark.normalizeCardAction` actually reads. Declared as a zod schema
 * so we can narrow `Record<string, unknown>` into a typed shape via
 * `safeParse` instead of an unsafe `as unknown as Lark.RawCardActionEvent`
 * cast at the boundary.
 */
export const schema1CardEvent = z.object({
  action: z.record(z.unknown()),
  open_message_id: z.string().optional(),
  open_chat_id: z.string().optional(),
  context: z
    .object({
      open_message_id: z.string().optional(),
      open_chat_id: z.string().optional(),
    })
    .partial()
    .optional(),
  operator: z
    .object({
      open_id: z.string().optional(),
      user_id: z.string().optional(),
      name: z.string().optional(),
    })
    .partial()
    .optional(),
});

/**
 * Decrypt `{ encrypt: "<base64>" }` payloads. Returns the original body
 * unchanged when no `encrypt` field is present, or `null` when decryption
 * fails (missing key / bad ciphertext). The cipher matches the official
 * Lark SDK: AES-256-CBC, key = sha256(encryptKey), iv = first 16 bytes.
 */
export function maybeDecrypt(
  rawBody: unknown,
  keys: FeishuCallbackKeys,
  logger: CallbackLogger,
): Record<string, unknown> | null {
  if (typeof rawBody !== 'object' || rawBody === null) return null;
  const body = rawBody as Record<string, unknown>;
  const encrypted = body['encrypt'];
  if (typeof encrypted !== 'string') return body;
  if (keys.encryptKey === null) {
    logger.warn('feishu_card_encrypt_key_missing');
    return null;
  }
  try {
    const buf = Buffer.from(encrypted, 'base64');
    const key = crypto.createHash('sha256').update(keys.encryptKey).digest();
    const iv = buf.subarray(0, 16);
    const ct = buf.subarray(16);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    return JSON.parse(plain) as Record<string, unknown>;
  } catch (err) {
    logger.warn(`feishu_card_decrypt_failed err=${String(err)}`);
    return null;
  }
}

/**
 * Optional SHA-1 / SHA-256 signature verification — only enforced when
 * a token / encrypt key is configured. Schema 2.0 with encryption uses
 * SHA-256(timestamp+nonce+encryptKey+rawBody); schema 1.0 plain uses
 * SHA-1(timestamp+nonce+verificationToken+rawBody). When neither
 * applies (no token configured), the call is accepted.
 */
export function verifySignature(
  rawBody: unknown,
  headers: Readonly<Record<string, string | undefined>>,
  keys: FeishuCallbackKeys,
): boolean {
  if (keys.verificationToken === null && keys.encryptKey === null) return true;
  const signature = headers['x-lark-signature'];
  if (typeof signature !== 'string' || signature.length === 0) return true;
  const timestamp = headers['x-lark-request-timestamp'] ?? '';
  const nonce = headers['x-lark-request-nonce'] ?? '';
  const bodyStr = JSON.stringify(rawBody);
  if (keys.encryptKey !== null) {
    const sha256 = crypto
      .createHash('sha256')
      .update(timestamp + nonce + keys.encryptKey + bodyStr)
      .digest('hex');
    if (sha256 === signature) return true;
  }
  if (keys.verificationToken !== null) {
    const sha1 = crypto
      .createHash('sha1')
      .update(timestamp + nonce + keys.verificationToken + bodyStr)
      .digest('hex');
    if (sha1 === signature) return true;
  }
  return false;
}

/**
 * Pull the `RawCardActionEvent` shape out of either a schema-2 envelope
 * (`{ schema:"2.0", header, event }`) or a schema-1 flat body
 * (`{ open_id, action, open_message_id, … }`). Returns `null` for
 * payloads that don't match either — typically other event types Feishu
 * also routes to the callback URL.
 */
export function extractCardEvent(
  body: Record<string, unknown>,
): Lark.RawCardActionEvent | null {
  const v2 = schema2Envelope.safeParse(body);
  if (v2.success) {
    // The inner `event` is itself a flat schema-1-style payload — narrow
    // through the same zod gate before handing it to the SDK.
    const inner = schema1CardEvent.safeParse(v2.data.event);
    return inner.success ? toRawCardActionEvent(inner.data) : null;
  }
  const v1 = schema1CardEvent.safeParse(body);
  if (v1.success) {
    // `Lark.normalizeCardAction` needs at least one of `open_message_id`
    // / `open_chat_id` (whether on the root or nested under `context`).
    // Fail closed otherwise.
    const hasMid =
      v1.data.open_message_id !== undefined || v1.data.context?.open_message_id !== undefined;
    const hasCid =
      v1.data.open_chat_id !== undefined || v1.data.context?.open_chat_id !== undefined;
    if (hasMid || hasCid) return toRawCardActionEvent(v1.data);
  }
  return null;
}

/**
 * Strip `undefined`-valued properties from a zod-parsed card event so it
 * satisfies the SDK's {@link Lark.RawCardActionEvent} shape under TS
 * `exactOptionalPropertyTypes`. The runtime payload we just validated is
 * already structurally compatible — this is purely a type-system gate
 * so we don't have to write `as unknown as Lark.RawCardActionEvent`.
 */
function toRawCardActionEvent(
  parsed: z.infer<typeof schema1CardEvent>,
): Lark.RawCardActionEvent {
  const compact: Record<string, unknown> = { action: parsed.action };
  if (parsed.open_message_id !== undefined) compact['open_message_id'] = parsed.open_message_id;
  if (parsed.open_chat_id !== undefined) compact['open_chat_id'] = parsed.open_chat_id;
  if (parsed.context !== undefined) {
    const ctx: Record<string, unknown> = {};
    if (parsed.context.open_message_id !== undefined)
      ctx['open_message_id'] = parsed.context.open_message_id;
    if (parsed.context.open_chat_id !== undefined)
      ctx['open_chat_id'] = parsed.context.open_chat_id;
    compact['context'] = ctx;
  }
  if (parsed.operator !== undefined) {
    const op: Record<string, unknown> = {};
    if (parsed.operator.open_id !== undefined) op['open_id'] = parsed.operator.open_id;
    if (parsed.operator.user_id !== undefined) op['user_id'] = parsed.operator.user_id;
    if (parsed.operator.name !== undefined) op['name'] = parsed.operator.name;
    compact['operator'] = op;
  }
  return compact as Lark.RawCardActionEvent;
}
