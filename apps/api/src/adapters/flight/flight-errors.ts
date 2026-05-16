/**
 * Classifiers for Flight / gRPC errors. Shared by orchestration queues,
 * watch scheduler and any caller that wants to differentiate pool-class
 * (connection-level) failures from task-class (per-call) failures.
 *
 * Pool-class examples surface as substrings in the gRPC error message:
 *   - `ECONNREFUSED` — python flight server down.
 *   - `ECONNRESET`   — proxy / NAT dropped the TCP connection mid-call.
 *   - `UNAVAILABLE`  — gRPC status 14.
 *   - `connect ETIMEDOUT` — outbound connect timed out.
 *   - `socket hang up` — keepalive proxy abort.
 *
 * Task-class examples come back as a `QuantError` with `details.reason
 * === 'transport'` from the python side (akshare proxy/connect aborts
 * during a single quote/kline fetch).
 */

import { QuantError } from '@quant/shared';

const POOL_NEEDLES = [
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'EPIPE',
  'ETIMEDOUT',
  'UNAVAILABLE',
  'No connection established',
  'connect aborted',
  'socket hang up',
  'http proxy',
  'HTTP proxy',
];

/**
 * `true` when the error indicates the python flight channel itself is
 * unusable (caller should pause its pool until recovery). Substring
 * match against the error message — stays decoupled from
 * `@grpc/grpc-js` internals.
 */
export function isPyFlightDown(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  for (const needle of POOL_NEEDLES) {
    if (msg.includes(needle)) return true;
  }
  return false;
}

/**
 * `true` when the python side surfaced a transport-class failure via
 * the structured Flight error envelope (e.g. akshare endpoint timed
 * out behind a proxy). Pool-class for queue purposes — the upstream
 * is alive but the route to it is failing, so backoff at pool level
 * lets the upstream recover.
 */
export function isTransportError(err: unknown): boolean {
  return err instanceof QuantError && err.details['reason'] === 'transport';
}

/**
 * `true` when the upstream surfaced a rate-limit. Yahoo's window is
 * minutes, not seconds, so the entire pool must back off — retrying a
 * single task would just consume cooldown headroom from sibling tasks.
 * The queue's `poolBackoff.baseMs` should be set higher for queues that
 * can trip this (e.g. the US watch queue with yfinance backend).
 */
export function isRateLimitError(err: unknown): boolean {
  return err instanceof QuantError && err.details['reason'] === 'rate_limited';
}

/**
 * Either pool-class signal — flight channel down OR python-tunnelled
 * transport / rate-limit failure. Used as the default
 * `poolBackoff.isPoolError` for queues that talk to python via Flight.
 */
export function isPoolLevelError(err: unknown): boolean {
  return isPyFlightDown(err) || isTransportError(err) || isRateLimitError(err);
}
