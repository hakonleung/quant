/**
 * Reassemble the Arrow IPC **stream** wire format from the per-message
 * pieces that Arrow Flight sends inside `FlightData.data_header` /
 * `data_body`.
 *
 * Flight transports each Arrow IPC message split across two protobuf
 * fields, so the `apache-arrow` reader cannot consume Flight bytes
 * directly. We rebuild the canonical IPC stream:
 *
 * ```
 * for each message:
 *   [continuation: u32 = 0xFFFFFFFF]
 *   [meta_len:    u32 LE  = length of header padded to 8 bytes]
 *   [data_header bytes, zero-padded to 8-byte alignment]
 *   [data_body   bytes  ]                  // no padding — bodyLength is
 *                                          // already in the header
 * end-of-stream:
 *   [continuation: u32 = 0xFFFFFFFF]
 *   [length:       u32 = 0]
 * ```
 *
 * Reference: Apache Arrow Columnar.rst §"IPC Streaming Format". Padding
 * rules are quirky — only the header is padded to 8 bytes by the writer;
 * the body's own padding is encoded inside the FlatBuffer.
 */

const CONTINUATION = 0xffffffff;
const ALIGN = 8;

function padToAlign(n: number): number {
  const rem = n % ALIGN;
  return rem === 0 ? n : n + (ALIGN - rem);
}

export interface FlightDataChunk {
  readonly dataHeader: Uint8Array;
  readonly dataBody: Uint8Array;
}

export function buildIpcStream(chunks: readonly FlightDataChunk[]): Uint8Array {
  // Compute total length first so we allocate once.
  let total = 0;
  for (const chunk of chunks) {
    const paddedHeader = padToAlign(chunk.dataHeader.byteLength);
    total += 4 + 4 + paddedHeader + chunk.dataBody.byteLength;
  }
  total += 4 + 4; // end-of-stream marker

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  let offset = 0;

  for (const chunk of chunks) {
    const paddedHeaderLen = padToAlign(chunk.dataHeader.byteLength);
    view.setUint32(offset, CONTINUATION, true);
    offset += 4;
    view.setUint32(offset, paddedHeaderLen, true);
    offset += 4;
    out.set(chunk.dataHeader, offset);
    offset += paddedHeaderLen; // pad bytes left as zero (Uint8Array default)
    if (chunk.dataBody.byteLength > 0) {
      out.set(chunk.dataBody, offset);
      offset += chunk.dataBody.byteLength;
    }
  }

  // End-of-stream
  view.setUint32(offset, CONTINUATION, true);
  offset += 4;
  view.setUint32(offset, 0, true);
  offset += 4;

  return out;
}
