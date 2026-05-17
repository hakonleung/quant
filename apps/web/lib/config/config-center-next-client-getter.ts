/**
 * Browser-safe ConfigCenter access.
 *
 * Each `process.env['NEXT_PUBLIC_*']` access MUST be a literal subscript
 * so Next.js / webpack DefinePlugin inlines the string at build time.
 * Aliasing `process.env` to a local variable defeats the substitution
 * and leaves a bare `process` reference that ReferenceErrors in the
 * browser bundle.
 *
 * Only writes fields env actually provides; defaults live in
 * `@quant/config`.
 */

import { ClientConfigCenter, type ClientConfig } from '@quant/config/client';

export function getClientConfig(): ClientConfig {
  try {
    return ClientConfigCenter.get().snapshot();
  } catch {
    return ClientConfigCenter.init({
      auth: {
        ...(process.env['NEXT_PUBLIC_AUTH_MODE'] === 'oauth' && { mode: 'oauth' }),
      },
      socket: {
        ...(process.env['NEXT_PUBLIC_QUANT_SOCKET_URL'] && {
          url: process.env['NEXT_PUBLIC_QUANT_SOCKET_URL'],
        }),
        ...(process.env['NEXT_PUBLIC_QUANT_API_PORT'] && {
          apiPort: process.env['NEXT_PUBLIC_QUANT_API_PORT'],
        }),
      },
      terminal: {
        ...(process.env['NEXT_PUBLIC_TM_RUNNER'] === 'mock' && {
          defaultRunner: 'mock',
        }),
      },
    }).snapshot();
  }
}

export type { ClientConfig };
