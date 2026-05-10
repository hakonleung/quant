/**
 * Feishu (Lark) adapter — outbound via the Open Platform `im.message`
 * API and inbound via the long-connection `WSClient`. Mirrors the Slack
 * adapter shape so `ChannelService` doesn't care which IM it's talking
 * to.
 *
 * The lark `Client` accepts a `disableTokenCache: false` default which
 * caches the tenant access token internally. Outbound `chat_id` defaults
 * to `cfg.defaultChatId`; callers can override per-message.
 *
 * `WSClient` runs Feishu's bidirectional event channel — same role as
 * Slack Socket Mode, no public ingress required.
 */

import { Logger } from '@nestjs/common';
import * as Lark from '@larksuiteoapi/node-sdk';

import type { FeishuConfig } from '../config/channel.config.js';
import {
  buildDecidedCard,
  parseCardAction,
  syntheticTextForAction,
  type ParsedCardAction,
} from './feishu-card-action.js';
import {
  challengeSchema,
  extractCardEvent,
  maybeDecrypt,
  verifySignature,
} from './feishu-callback.js';
import { pickCard, stripSlackMrkdwn, type FeishuV1Card } from './feishu-card.js';
import type {
  ChannelAdapter,
  InboundHandler,
  InboundMessage,
  OutboundMessage,
  OutboundResult,
} from '../ports/channel-adapter.port.js';

interface LarkMessageEvent {
  readonly sender?: { readonly sender_id?: { readonly open_id?: string } };
  readonly message?: {
    readonly chat_id?: string;
    readonly content?: string;
    readonly create_time?: string;
    readonly message_type?: string;
  };
}

interface ExtraHandles {
  'card.action.trigger': (data: Lark.RawCardActionEvent) => Promise<void>;
}

/**
 * Pull `{code, msg, error}` out of an AxiosError-like SDK rejection so
 * the caller can log a useful message instead of the bare HTTP status.
 * Returns a stable JSON string so the operator can grep for codes like
 * `230006` (invalid card payload).
 */
function extractFeishuErrorBody(err: unknown): string {
  if (typeof err !== 'object' || err === null) return String(err);
  const maybeResponse = (err as { response?: unknown }).response;
  if (typeof maybeResponse !== 'object' || maybeResponse === null) {
    return (err as { message?: string }).message ?? 'unknown';
  }
  const data = (maybeResponse as { data?: unknown }).data;
  if (data === undefined) return (err as { message?: string }).message ?? 'unknown';
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}

// Card-action helpers (`cardButtonSchema` / `parseCardAction` /
// `syntheticTextForAction` / `buildDecidedCard`) live in
// `./feishu-card-action.ts`. Card-callback decoding (URL-verification challenge schema, schema-1 /
// schema-2 envelope narrowing, AES decrypt, signature verification) lives
// in `./feishu-callback.ts` — kept out of this file to stay under the
// 400-LoC cap (CLAUDE.md §1.2). All four are pure helpers; this adapter
// only owns the lifecycle + dispatch wiring around them.

export type FeishuCallbackResult =
  | { readonly kind: 'challenge'; readonly challenge: string }
  | { readonly kind: 'accepted' }
  /**
   * Same as `accepted`, plus a card payload Feishu should atomically
   * substitute for the original interactive card in the chat. Only the
   * HTTP callback can take advantage; WS callbacks have no synchronous
   * response, so the WS path patches the message via `im.v1.message.patch`
   * instead.
   */
  | { readonly kind: 'replace_card'; readonly card: FeishuV1Card }
  | { readonly kind: 'ignored'; readonly reason: string };

export class FeishuChannelAdapter implements ChannelAdapter {
  readonly id = 'feishu' as const;
  private readonly logger = new Logger('FeishuChannelAdapter');
  private readonly client: Lark.Client;
  private readonly ws: Lark.WSClient | null;
  private readonly handlers: InboundHandler[] = [];
  private ready = false;
  private inboundConnected = false;

  constructor(
    private readonly cfg: FeishuConfig,
    private readonly dryRun: boolean,
  ) {
    this.client = new Lark.Client({
      appId: cfg.appId,
      appSecret: cfg.appSecret,
      disableTokenCache: false,
    });
    this.ws = dryRun ? null : new Lark.WSClient({ appId: cfg.appId, appSecret: cfg.appSecret });
  }

  async start(): Promise<void> {
    if (this.ws !== null) {
      const dispatcher = new Lark.EventDispatcher({}).register<ExtraHandles>({
        'im.message.receive_v1': async (data: LarkMessageEvent) => {
          await this.dispatchEvent(data);
        },
        'card.action.trigger': async (data: Lark.RawCardActionEvent) => {
          await this.dispatchCardAction(data);
        },
      });
      try {
        // WSClient.start() returns void but kicks off the long-conn loop.
        this.ws.start({ eventDispatcher: dispatcher });
        this.inboundConnected = true;
        this.logger.log('feishu_ws_started');
      } catch (err) {
        this.logger.warn(`feishu_ws_start_failed err=${String(err)}`);
      }
    }
    this.ready = true;
  }

  async stop(): Promise<void> {
    this.ready = false;
    this.inboundConnected = false;
    // WSClient has no documented stop in this SDK version — letting GC
    // clear the loop on process exit. Tracked as a follow-up.
  }

  isReady(): boolean {
    return this.ready;
  }

  isInboundConnected(): boolean {
    return this.inboundConnected;
  }

  subscribe(handler: InboundHandler): void {
    this.handlers.push(handler);
  }

  async send(message: OutboundMessage, traceId: string): Promise<OutboundResult> {
    const target = message.target ?? this.cfg.defaultChatId;
    if (target === '') {
      throw new Error('feishu_send_no_target: set CHANNEL_FEISHU_DEFAULT_CHAT_ID or pass target');
    }
    const card = pickCard(message);
    if (this.dryRun) {
      const preview =
        card !== null ? `card<${message.kind ?? 'unknown'}>` : message.text.slice(0, 80);
      this.logger.log(`feishu_send_dryrun trace_id=${traceId} target=${target} preview=${preview}`);
      return { status: 'dryrun', target };
    }
    const data =
      card !== null
        ? {
            receive_id: target,
            msg_type: 'interactive',
            content: JSON.stringify(card),
          }
        : {
            receive_id: target,
            msg_type: 'text',
            content: JSON.stringify({
              text: stripSlackMrkdwn(
                message.title !== undefined ? `${message.title}\n${message.text}` : message.text,
              ),
            }),
          };
    let res;
    try {
      res = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data,
      });
    } catch (err) {
      // Feishu's open-api SDK wraps a real HTTP 400 in an AxiosError whose
      // `response.data` carries the actual `{ code, msg, error }` payload —
      // without surfacing it the operator only sees "Request failed with
      // status code 400" and has to grep raw network logs. Log the body
      // (with a small preview of the card we sent) before rethrowing so
      // card-shape regressions are debuggable from the API logs alone.
      const body = extractFeishuErrorBody(err);
      const preview = card !== null ? JSON.stringify(card).slice(0, 600) : data.content.slice(0, 200);
      this.logger.error(
        `feishu_send_failed trace_id=${traceId} target=${target} body=${body} card_preview=${preview}`,
      );
      throw err;
    }
    const messageId = typeof res.data?.message_id === 'string' ? res.data.message_id : null;
    return {
      status: 'sent',
      target,
      ...(messageId !== null ? { providerMessageId: messageId } : {}),
      raw: { code: res.code },
    };
  }

  /**
   * Build the "decided" card. Wraps the pure helper with the `Date.now`
   * dependency so the adapter is the only place that touches the clock.
   */
  private decidedCardFor(action: ParsedCardAction): FeishuV1Card {
    // eslint-disable-next-line no-restricted-globals -- adapter has no Clock
    return buildDecidedCard(action.value, action.openId, new Date().toISOString());
  }

  /**
   * Patch a previously sent interactive message with a new card payload.
   * Used by the WS card-action path where there's no synchronous
   * response channel — we have to call `im.v1.message.patch` to replace
   * the card in-place. Failures degrade gracefully (log + continue) so a
   * patch error never blocks the underlying agent dispatch.
   */
  private async patchMessageCard(messageId: string, card: FeishuV1Card): Promise<void> {
    if (this.dryRun || messageId.length === 0) return;
    try {
      await this.client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify(card) },
      });
    } catch (err) {
      this.logger.warn(`feishu_card_patch_failed messageId=${messageId} err=${String(err)}`);
    }
  }

  /**
   * Handles an HTTP Card Request URL callback from Feishu.
   *
   * Pipeline:
   *   1. If the body is `{ encrypt }`, AES-decrypt with `CHANNEL_FEISHU_ENCRYPT_KEY`
   *      (Feishu uses AES-256-CBC, key = SHA-256(encryptKey), iv = first 16 bytes).
   *   2. If the decrypted/plain body is a URL-verification challenge, return it
   *      so the controller can echo it back synchronously.
   *   3. Optionally verify the request's SHA-1 / SHA-256 signature against
   *      `CHANNEL_FEISHU_VERIFICATION_TOKEN` headers.
   *   4. Extract the inner `event` object (schema 2.0) or use the body itself
   *      (schema 1.0) and fire-and-forget through `dispatchCardAction`.
   *
   * Feishu requires a response within 3 seconds, so dispatching is async.
   */
  handleHttpCardCallback(
    rawBody: unknown,
    headers: Readonly<Record<string, string | undefined>> = {},
  ): FeishuCallbackResult {
    const decoded = maybeDecrypt(rawBody, this.cfg, this.logger);
    if (decoded === null) {
      return { kind: 'ignored', reason: 'decrypt_failed' };
    }

    const challenge = challengeSchema.safeParse(decoded);
    if (challenge.success) {
      this.logger.log('feishu_card_challenge');
      return { kind: 'challenge', challenge: challenge.data.challenge };
    }

    if (!verifySignature(rawBody, headers, this.cfg)) {
      this.logger.warn('feishu_card_signature_mismatch');
      return { kind: 'ignored', reason: 'signature_mismatch' };
    }

    const inner = extractCardEvent(decoded);
    if (inner === null) {
      this.logger.warn(`feishu_card_unknown_payload keys=${Object.keys(decoded).join(',')}`);
      return { kind: 'ignored', reason: 'unknown_payload' };
    }

    // Pre-parse the action up-front so we can return the "decided" card
    // synchronously to Feishu — the HTTP callback's response body is the
    // *only* way to update the card without a separate `im.v1.message.patch`
    // call, and Feishu requires the response within 3 seconds.
    const action = parseCardAction(inner, this.logger);
    void this.dispatchCardAction(inner, { skipPatch: true }).catch((err: unknown) => {
      this.logger.warn(`feishu_http_card_dispatch_err err=${String(err)}`);
    });
    if (action === null) {
      return { kind: 'accepted' };
    }
    return {
      kind: 'replace_card',
      card: this.decidedCardFor(action),
    };
  }

  private async dispatchCardAction(
    raw: Lark.RawCardActionEvent,
    opts: { readonly skipPatch?: boolean } = {},
  ): Promise<void> {
    const action = parseCardAction(raw, this.logger);
    if (action === null) return;
    const syntheticText = syntheticTextForAction(action.value);
    if (syntheticText === null) {
      this.logger.warn(
        `feishu_card_action_no_synthetic action=${action.value.action} corr=${action.value.correlationId ?? '-'}`,
      );
      return;
    }
    this.logger.log(
      `feishu_card_dispatch openId=${action.openId} chatId=${action.chatId} action=${action.value.action}`,
    );

    // WS path → no synchronous response, so patch the message ourselves.
    // HTTP path passes `skipPatch:true` because the controller will
    // include the decided card in the callback response and Feishu does
    // the swap atomically; calling patch here would just race that.
    if (opts.skipPatch !== true) {
      void this.patchMessageCard(action.messageId, this.decidedCardFor(action));
    }

    // eslint-disable-next-line no-restricted-globals -- adapter has no Clock; mirrors dispatchEvent pattern
    const receivedAt = new Date().toISOString();
    const inbound: InboundMessage = {
      channel: 'feishu',
      sender: `feishu:${action.openId}`,
      text: syntheticText,
      ...(action.chatId.length > 0 ? { target: action.chatId } : {}),
      receivedAt,
      raw,
    };
    for (const h of this.handlers) {
      try {
        await h(inbound);
      } catch (err) {
        this.logger.warn(`feishu_card_action_handler_err err=${String(err)}`);
      }
    }
  }

  private async dispatchEvent(data: LarkMessageEvent): Promise<void> {
    const msg = data.message;
    if (msg === undefined || msg.message_type !== 'text') return;
    let text = '';
    if (typeof msg.content === 'string') {
      try {
        const parsed = JSON.parse(msg.content) as { text?: string };
        text = parsed.text ?? '';
      } catch {
        text = msg.content;
      }
    }
    if (text.length === 0) return;
    const inbound: InboundMessage = {
      channel: 'feishu',
      sender: `feishu:${data.sender?.sender_id?.open_id ?? 'unknown'}`,
      text,
      ...(typeof msg.chat_id === 'string' ? { target: msg.chat_id } : {}),
      receivedAt: new Date().toISOString(),
      raw: data,
    };
    for (const h of this.handlers) {
      try {
        await h(inbound);
      } catch (err) {
        this.logger.warn(`feishu_inbound_handler_err err=${String(err)}`);
      }
    }
  }
}

// `toRawCardActionEvent` lives in `./feishu-callback.ts` along with the
// other callback-decoding helpers (challenge / decrypt / sig-verify /
// envelope narrowing).
