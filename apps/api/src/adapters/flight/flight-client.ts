/**
 * Minimal Apache Arrow Flight client for the NestJS gateway
 * (ipc-py-ts.md §3, §5, §7). Only the two RPCs the v1 stack uses are
 * supported: `GetFlightInfo` (unary) and `DoGet` (server stream).
 *
 * The client speaks the `{op, args}` JSON descriptor protocol agreed with
 * the Python server (see `services/py/quant_rpc/server.py`). Errors are
 * surfaced as {@link QuantError} with the `code` recovered from the
 * Python-side envelope (see {@link parseFlightErrorPayload}).
 */

import {
  credentials,
  Metadata,
  status as GrpcStatus,
  type ChannelCredentials,
  type ServiceError,
  type Client,
} from '@grpc/grpc-js';
import { tableFromIPC, type Table } from 'apache-arrow';
import { QuantError, parseFlightErrorPayload, TRACE_HEADER, newTraceId } from '@quant/shared';
import { FlightService } from './proto-loader.js';
import { buildIpcStream, type FlightDataChunk } from './ipc-stream.js';

interface FlightDescriptorMessage {
  type: 'CMD' | 'PATH' | 'UNKNOWN';
  cmd: Buffer;
  path: string[];
}

interface TicketMessage {
  ticket: Buffer;
}

interface FlightInfoMessage {
  schema: Buffer;
  flight_descriptor: FlightDescriptorMessage;
  endpoint: { ticket: TicketMessage; location: { uri: string }[] }[];
  total_records: string;
  total_bytes: string;
}

interface FlightDataMessage {
  flight_descriptor: FlightDescriptorMessage | null;
  data_header: Buffer;
  app_metadata: Buffer;
  data_body: Buffer;
}

// gRPC clients constructed via proto-loader expose dynamic methods; we
// narrow to the call signatures we actually use.
interface FlightClientImpl extends Client {
  GetFlightInfo(
    request: FlightDescriptorMessage,
    metadata: Metadata,
    callback: (err: ServiceError | null, response: FlightInfoMessage) => void,
  ): void;
  DoGet(request: TicketMessage, metadata: Metadata): NodeJS.ReadableStream;
}

export interface FlightCallOptions {
  /** Trace id forwarded as `x-trace-id`. Auto-generated if omitted. */
  readonly traceId?: string;
  /** Per-RPC deadline in ms. */
  readonly deadlineMs?: number;
}

export interface FlightCallResult<T> {
  readonly value: T;
  readonly traceId: string;
}

/**
 * Thin wrapper around a gRPC `FlightService` client that exposes a
 * Promise-based API and absorbs the wire-format chores (JSON descriptor,
 * IPC stream reassembly, error envelope parsing).
 */
export class FlightClient {
  private readonly impl: FlightClientImpl;

  constructor(target: string, creds: ChannelCredentials = credentials.createInsecure()) {
    // The proto-loader-built constructor returns a dynamic ServiceClient.
    // Method names come from the .proto and are not visible to the static
    // type checker; we narrow at the boundary (asserted in proto-loader.ts
    // that the constructor exists). CLAUDE.md §1.2 bans single `as`
    // assertions, but this is the documented grpc-js + proto-loader bridge
    // — there is no runtime way to recover the typed surface.
    const client = new FlightService(target, creds);
    if (typeof (client as unknown as Record<string, unknown>)['GetFlightInfo'] !== 'function') {
      throw new Error('FlightService client missing GetFlightInfo');
    }
    this.impl = client as unknown as FlightClientImpl;
  }

  /** Cleanly close the underlying gRPC channel. */
  close(): void {
    this.impl.close();
  }

  /**
   * Run an op and return its result table.
   *
   * @throws QuantError if the server returns a Quant envelope, or with
   *   code `INTERNAL` if the gRPC call itself fails.
   */
  async doGet(
    op: string,
    args: Record<string, unknown> = {},
    options: FlightCallOptions = {},
  ): Promise<FlightCallResult<Table>> {
    const traceId = options.traceId ?? newTraceId();
    const command = Buffer.from(JSON.stringify({ op, args }), 'utf8');

    // 1. GetFlightInfo to claim the ticket. The Python server returns the
    //    same command back as the ticket so this round-trip is mostly a
    //    contract handshake (and a chance for the server to fail-fast on
    //    bad ops before opening a stream).
    const info = await this.callGetFlightInfo(command, traceId, options.deadlineMs);
    const endpoint = info.endpoint[0];
    if (endpoint === undefined) {
      throw new QuantError('INTERNAL', 'Flight server returned no endpoints', { op });
    }

    // 2. DoGet streams Arrow IPC chunks back. Collect, reassemble into the
    //    canonical IPC stream, and decode in one pass.
    const chunks = await this.collectStream(endpoint.ticket, traceId, options.deadlineMs);
    const ipcBytes = buildIpcStream(chunks);
    const table = tableFromIPC(ipcBytes);
    return { value: table, traceId };
  }

  // -- internals ------------------------------------------------------

  private callGetFlightInfo(
    cmd: Buffer,
    traceId: string,
    deadlineMs: number | undefined,
  ): Promise<FlightInfoMessage> {
    const metadata = makeMetadata(traceId);
    const descriptor: FlightDescriptorMessage = { type: 'CMD', cmd, path: [] };
    return new Promise<FlightInfoMessage>((resolve, reject) => {
      const timer = startDeadlineTimer(deadlineMs, reject);
      this.impl.GetFlightInfo(descriptor, metadata, (err, response) => {
        clearDeadlineTimer(timer);
        if (err) {
          reject(translateGrpcError(err, traceId));
          return;
        }
        resolve(response);
      });
    });
  }

  private collectStream(
    ticket: TicketMessage,
    traceId: string,
    deadlineMs: number | undefined,
  ): Promise<FlightDataChunk[]> {
    const metadata = makeMetadata(traceId);
    return new Promise<FlightDataChunk[]>((resolve, reject) => {
      const stream = this.impl.DoGet(ticket, metadata);
      const chunks: FlightDataChunk[] = [];
      const timer = startDeadlineTimer(deadlineMs, (err) => {
        // Hint to grpc-js to abort the call.
        (stream as unknown as { cancel?: () => void }).cancel?.();
        reject(err);
      });
      stream.on('data', (msg: FlightDataMessage) => {
        chunks.push({ dataHeader: msg.data_header, dataBody: msg.data_body });
      });
      stream.on('end', () => {
        clearDeadlineTimer(timer);
        resolve(chunks);
      });
      stream.on('error', (err: ServiceError) => {
        clearDeadlineTimer(timer);
        reject(translateGrpcError(err, traceId));
      });
    });
  }
}

function makeMetadata(traceId: string): Metadata {
  const md = new Metadata();
  md.set(TRACE_HEADER, traceId);
  return md;
}

function startDeadlineTimer(
  deadlineMs: number | undefined,
  onTimeout: (err: QuantError) => void,
): NodeJS.Timeout | null {
  if (deadlineMs === undefined) return null;
  return setTimeout(() => {
    onTimeout(new QuantError('INTERNAL', `Flight call exceeded ${String(deadlineMs)}ms deadline`));
  }, deadlineMs);
}

function clearDeadlineTimer(timer: NodeJS.Timeout | null): void {
  if (timer !== null) clearTimeout(timer);
}

function translateGrpcError(err: ServiceError, fallbackTraceId: string): QuantError {
  // Python server tunnels structured info through err.details; gRPC also
  // copies it into err.message with a "Detail: ..." suffix. Try details
  // first since it's the cleanest source.
  const candidates = [err.details, err.message].filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  );
  for (const candidate of candidates) {
    const payload = parseFlightErrorPayload(candidate);
    if (payload !== null) {
      return new QuantError(payload.code, payload.message, {
        ...payload.details,
        trace_id: payload.traceId,
      });
    }
  }
  // No envelope — surface the raw gRPC failure as INTERNAL.
  return new QuantError('INTERNAL', err.message || `grpc error ${String(err.code)}`, {
    grpc_code: typeof err.code === 'number' ? GrpcStatus[err.code] : err.code,
    trace_id: fallbackTraceId,
  });
}
