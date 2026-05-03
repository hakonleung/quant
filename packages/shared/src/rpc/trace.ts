/**
 * Shared trace-id constants. Header name matches the Python side
 * (`quant_rpc.trace.TRACE_HEADER`); both gateway and Flight server agree
 * on the lowercase form because gRPC normalises metadata keys to
 * lowercase.
 *
 * `newTraceId` returns a 32-char lowercase hex string (UUIDv4 without
 * dashes), matching Python's `quant_rpc.trace.new_trace_id`. The
 * implementation is isomorphic — Web Crypto in the browser, Node Crypto
 * on the server — so the same `@quant/shared` build works in both.
 */

export const TRACE_HEADER = 'x-trace-id' as const;

export function newTraceId(): string {
  // `globalThis.crypto.randomUUID()` is available in modern Node (>= 20)
  // and every evergreen browser. Avoid `node:crypto` so webpack doesn't
  // need a polyfill.
  const cryptoLike = globalThis.crypto;
  if (cryptoLike !== undefined && typeof cryptoLike.randomUUID === 'function') {
    return cryptoLike.randomUUID().replace(/-/g, '');
  }
  // Fallback: 16 random bytes → hex.
  const bytes = new Uint8Array(16);
  if (cryptoLike !== undefined && typeof cryptoLike.getRandomValues === 'function') {
    cryptoLike.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  let hex = '';
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}
