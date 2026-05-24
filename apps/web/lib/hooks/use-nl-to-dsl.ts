'use client';

import type { NlToDslResult } from '@quant/shared';
import { useMutation, type UseMutationResult } from '@tanstack/react-query';

import { nlToDsl } from '../api/endpoints.js';

/**
 * Translation-only mutation — returns the parsed AST without executing
 * the screen. Used by the dynamic-sector create dialog to preview the
 * DSL before saving; the actual stock matches are produced later by
 * `sector.refresh`.
 */
export function useNlToDsl(): UseMutationResult<
  NlToDslResult,
  Error,
  { readonly nl: string; readonly asof?: string },
  unknown
> {
  return useMutation({
    mutationKey: ['screen.nl2dsl'],
    mutationFn: ({ nl, asof }) => nlToDsl(nl, asof),
  });
}
