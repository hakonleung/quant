/**
 * Browser-side singleton for the realtime Socket.IO connection
 * (`docs/modules/12-socket.md`).
 *
 * The web app talks to the NestJS gateway directly here — same-host
 * different-port CORS lets us skip the Next BFF for the socket alone
 * (the rest of the BFF anti-corruption layer remains for HTTP). The
 * default URL is `http://<current-hostname>:3001`, which works whether
 * the user opened the app via `localhost` or `127.0.0.1`. Override
 * with `NEXT_PUBLIC_QUANT_SOCKET_URL` for non-loopback deploys.
 */

'use client';

import { io, type Socket } from 'socket.io-client';

let socketSingleton: Socket | null = null;

function resolveUrl(): string {
  const env = process.env['NEXT_PUBLIC_QUANT_SOCKET_URL'];
  if (typeof env === 'string' && env.length > 0) return env;
  if (typeof window === 'undefined') return 'http://127.0.0.1:3001';
  const port = process.env['NEXT_PUBLIC_QUANT_API_PORT'] ?? '3001';
  return `${window.location.protocol}//${window.location.hostname}:${port}`;
}

export function getSocket(): Socket {
  if (socketSingleton !== null) return socketSingleton;
  socketSingleton = io(resolveUrl(), {
    withCredentials: true,
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 10_000,
  });
  return socketSingleton;
}

/** Force a reconnect — useful for tests; not exposed in production UI. */
export function _resetSocket(): void {
  if (socketSingleton !== null) {
    socketSingleton.disconnect();
    socketSingleton = null;
  }
}
