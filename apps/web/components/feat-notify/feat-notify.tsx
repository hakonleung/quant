'use client';

/**
 * Floating notification stack — surfaces entries from
 * `useNotifyStore` as auto-dismissing toasts. Mounted once at the
 * shell root so any layer of the app can `notify.error(...)` without
 * mounting its own UI.
 *
 * Layout:
 *   - Desktop: top-right cluster, anchored above the page chrome,
 *     stacks downwards (newest at bottom)
 *   - Mobile: bottom-anchored above the bottom-tab bar / safe-area
 *     home indicator, stacks upwards (newest on top of the stack)
 *
 * Each toast:
 *   - clickable → dismiss
 *   - auto-dismisses after its `ttlMs` (errors are pinned by default)
 *   - ARIA `role="status"` for info / success, `role="alert"` for
 *     warn / error so screen readers announce destructive issues
 *     immediately
 *
 * Visual tone reuses the existing accent / up / down / amber tokens
 * — no new palette is introduced.
 */

import { Box, Flex, Text } from '@chakra-ui/react';
import { useEffect, type ReactElement } from 'react';

import { useViewport } from '../../lib/hooks/use-viewport.js';
import {
  useNotifyStore,
  type NotifyEntry,
  type NotifyTone,
} from '../../lib/stores/notify.store.js';

const TONE_BAR: Record<NotifyTone, string> = {
  info: 'accent',
  success: 'up',
  warn: 'amber',
  error: 'down',
};

const TONE_GLYPH: Record<NotifyTone, string> = {
  info: 'i',
  success: '✓',
  warn: '!',
  error: '×',
};

const TONE_ROLE: Record<NotifyTone, 'status' | 'alert'> = {
  info: 'status',
  success: 'status',
  warn: 'alert',
  error: 'alert',
};

export function FeatNotify(): ReactElement | null {
  const entries = useNotifyStore((s) => s.entries);
  const dismiss = useNotifyStore((s) => s.dismiss);
  const { mode: vpMode } = useViewport();
  const isMobile = vpMode === 'mobile';
  if (entries.length === 0) return null;

  const stack = isMobile ? [...entries].reverse() : entries;

  return (
    <Box
      position="fixed"
      zIndex="toast"
      pointerEvents="none"
      // Desktop pin to top-right under the topbar accent border;
      // mobile pin to the bottom so the soft keyboard / tab bar can
      // never push toasts off-screen. Both leave the safe-area
      // insets in `style` so iOS notch + home bar are respected.
      top={isMobile ? 'auto' : '64px'}
      bottom={isMobile ? '60px' : 'auto'}
      right={isMobile ? '0' : '16px'}
      left={isMobile ? '0' : 'auto'}
      display="flex"
      flexDirection={isMobile ? 'column' : 'column'}
      alignItems={isMobile ? 'stretch' : 'flex-end'}
      gap="8px"
      px={isMobile ? '12px' : '0'}
      style={{
        paddingLeft: isMobile ? 'max(12px, env(safe-area-inset-left))' : undefined,
        paddingRight: isMobile ? 'max(12px, env(safe-area-inset-right))' : undefined,
      }}
      role="region"
      aria-label="通知"
      aria-live="polite"
    >
      {stack.map((entry) => (
        <Toast
          key={entry.id}
          entry={entry}
          onDismiss={(): void => {
            dismiss(entry.id);
          }}
        />
      ))}
    </Box>
  );
}

interface ToastProps {
  readonly entry: NotifyEntry;
  readonly onDismiss: () => void;
}

function Toast({ entry, onDismiss }: ToastProps): ReactElement {
  // Auto-dismiss timer scoped to the React life-cycle, so a tab
  // switch + return doesn't fire a stale timeout. `null` ttl pins
  // the toast — used for errors that the user must read.
  useEffect(() => {
    if (entry.ttlMs === null) return;
    const t = setTimeout(onDismiss, entry.ttlMs);
    return () => {
      clearTimeout(t);
    };
  }, [entry.ttlMs, onDismiss]);
  return (
    <Flex
      role={TONE_ROLE[entry.tone]}
      onClick={onDismiss}
      pointerEvents="auto"
      // Notification card uses the same Liquid Glass material as
      // panes/dialogs: transparent bg + backdrop-filter + hairline
      // border, no shadow. Tone is conveyed by the 3 px left bar
      // alone.
      bg="transparent"
      backdropFilter="blur(16px) saturate(180%)"
      color="ink"
      borderWidth="1px"
      borderColor="glass.line"
      borderLeftWidth="3px"
      borderLeftColor={TONE_BAR[entry.tone]}
      px="12px"
      py="10px"
      gap="10px"
      align="flex-start"
      minW={{ base: 'auto', md: '280px' }}
      maxW={{ base: '100%', md: '420px' }}
      cursor="pointer"
      _hover={{ borderLeftColor: 'accent' }}
    >
      <Text
        fontFamily="mono"
        fontSize="sm"
        fontWeight="700"
        color={TONE_BAR[entry.tone]}
        lineHeight="1.5"
        flexShrink={0}
        w="14px"
        textAlign="center"
      >
        {TONE_GLYPH[entry.tone]}
      </Text>
      <Box flex="1" minW={0}>
        <Flex align="baseline" gap="6px">
          <Text fontFamily="mono" fontSize="sm" fontWeight="600" color="ink" flex="1" minW={0}>
            {entry.title}
          </Text>
          {entry.code !== undefined && (
            <Text fontFamily="mono" fontSize="xs" color="ink3" letterSpacing="0.12em">
              {entry.code}
            </Text>
          )}
        </Flex>
        {entry.body !== undefined && (
          <Text
            fontFamily="mono"
            fontSize="xs"
            color="ink2"
            mt="2px"
            whiteSpace="pre-wrap"
            lineHeight="1.5"
          >
            {entry.body}
          </Text>
        )}
      </Box>
      <Text
        fontFamily="mono"
        fontSize="xs"
        color="ink3"
        letterSpacing="0.16em"
        flexShrink={0}
        aria-hidden="true"
      >
        ×
      </Text>
    </Flex>
  );
}
