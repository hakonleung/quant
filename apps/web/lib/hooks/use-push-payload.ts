'use client';

/**
 * Shared mutation for the SYS.PUSH test endpoint.
 *
 * Pane-level "push" buttons (AI.OUT, AI.HIST) reuse this so the slack
 * delivery surface lives in one place — the BFF echoes back
 * `{dryRun:true}` when no webhook is configured.
 */

import {
  PushTestResponseSchema,
  type PushTestRequest,
  type PushTestResponse,
} from '@quant/shared';
import { useMutation, type UseMutationResult } from '@tanstack/react-query';

import { apiPost } from '../api/client.js';

export function usePushPayload(): UseMutationResult<PushTestResponse, Error, PushTestRequest> {
  return useMutation<PushTestResponse, Error, PushTestRequest>({
    mutationFn: (body) =>
      apiPost('/api/push/test', body, (raw) => PushTestResponseSchema.parse(raw)),
  });
}
