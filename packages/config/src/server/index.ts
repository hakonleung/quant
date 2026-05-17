/**
 * NestJS / Next.js server-side ConfigCenter entry point.
 *
 * Subpath export `@quant/config/server`. Never import this from a
 * `'use client'` component — the bundler will pull the whole server
 * graph (including `auth.secret`) into the browser bundle.
 */

export {
  ServerConfigCenter,
  type ResolvedServerConfig,
  type ServerConfigOverrides,
} from './config-center.server.js';

export const CONFIG_CENTER = Symbol('CONFIG_CENTER');
