'use client';

import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';

import { apiGet } from '../api/client.js';

const AuthMeSchema = z.object({
  id: z.string().min(1),
  displayName: z.string(),
  source: z.enum(['oauth', 'env', 'im']),
  imBootstrap: z.boolean(),
  originalUserId: z.string().optional(),
});
export type AuthMe = z.infer<typeof AuthMeSchema>;

/**
 * Resolved current user. Cached for 5 minutes (auth state rarely changes
 * mid-session). Null while loading or on error — UI gates that depend on
 * ownership simply hide the affordance until the id resolves, which is
 * the correct conservative behaviour.
 */
export function useCurrentUserId(): string | null {
  const q = useQuery({
    queryKey: ['auth.me'],
    queryFn: async () => apiGet('/api/auth/me', (r) => AuthMeSchema.parse(r)),
    staleTime: 5 * 60_000,
  });
  return q.data?.id ?? null;
}
