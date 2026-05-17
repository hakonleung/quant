/**
 * Browser-safe ConfigCenter access.
 *
 * Next.js inlines literal `process.env.NEXT_PUBLIC_*` reads at build
 * time, so the same code resolves on both server and client. Only
 * writes fields env actually provides — defaults come from
 * `@quant/config`.
 */

import { ClientConfigCenter, type ClientConfig } from '@quant/config/client';

export function getClientConfig(): ClientConfig {
  try {
    return ClientConfigCenter.get().snapshot();
  } catch {
    const e = process.env;
    return ClientConfigCenter.init({
      auth: {
        ...(e['NEXT_PUBLIC_AUTH_MODE'] === 'oauth' && { mode: 'oauth' }),
      },
      socket: {
        ...(e['NEXT_PUBLIC_QUANT_SOCKET_URL'] && {
          url: e['NEXT_PUBLIC_QUANT_SOCKET_URL'],
        }),
        ...(e['NEXT_PUBLIC_QUANT_API_PORT'] && {
          apiPort: e['NEXT_PUBLIC_QUANT_API_PORT'],
        }),
      },
      terminal: {
        ...(e['NEXT_PUBLIC_TM_RUNNER'] === 'mock' && { defaultRunner: 'mock' }),
      },
    }).snapshot();
  }
}

export type { ClientConfig };
