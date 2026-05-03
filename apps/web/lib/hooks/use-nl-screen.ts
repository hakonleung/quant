'use client';

import type { NlScreenResult } from '@quant/shared';
import { useMutation, type UseMutationResult } from '@tanstack/react-query';

import { runNlScreen } from '../api/endpoints.js';

/**
 * Mutation hook for the NL → DSL → screen pipeline. Result carries both
 * the matched stocks and the parsed AST; callers render both side by
 * side (modules/07-frontend.md §4.3.3).
 */
export function useNlScreen(): UseMutationResult<
  NlScreenResult,
  Error,
  { readonly nl: string; readonly asof?: string },
  unknown
> {
  return useMutation({
    mutationKey: ['screen.nl'],
    mutationFn: ({ nl, asof }) => runNlScreen(nl, asof),
  });
}
