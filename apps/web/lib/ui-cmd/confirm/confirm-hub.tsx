'use client';

/**
 * `ConfirmHub` — single global confirm dialog. Mount once from
 * providers.tsx. Subscribes to `useConfirmHubStore` and renders the
 * pending dialog (or null). Backdrop click + Esc cancel; the keyboard
 * engine's Esc priority chain reaches `modalOpen` last, but the dialog
 * sets it via setModalOpen so the engine's `closeModal` cell call lands
 * here when nothing else owns Esc.
 */

import { Box, Button, Flex, Text } from '@chakra-ui/react';
import { DialogPortal } from '../../../components/feat-view/dialog-portal.js';
import { useEffect, useRef } from 'react';

import { useFocusStore } from '../store/focus.js';
import { useConfirmHubStore, type ConfirmOptions } from './store.js';

export function ConfirmHub(): React.ReactElement | null {
  const pending = useConfirmHubStore((s) => s.pending);
  const resolve = useConfirmHubStore((s) => s.resolvePending);
  const cancel = useConfirmHubStore((s) => s.cancelPending);
  const setModalOpen = useFocusStore((s) => s.setModalOpen);
  // Remembers the element that had focus when the dialog opened so we
  // can return focus there on close — a11y §10.2 dialog requirement.
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Mirror dialog presence into the keyboard engine's `modalOpen` so
  // Esc → closeModal lands here when no fullscreen / sequence buffer.
  useEffect(() => {
    if (pending !== null) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
      setModalOpen(true);
    } else {
      setModalOpen(false);
      const prev = previousFocusRef.current;
      previousFocusRef.current = null;
      // Defer to next tick so the dialog's unmount completes before we
      // move focus — otherwise React may steal it back during reconcile.
      if (prev !== null && typeof prev.focus === 'function') {
        queueMicrotask(() => prev.focus());
      }
    }
    return (): void => setModalOpen(false);
  }, [pending, setModalOpen]);

  if (pending === null) return null;
  return <Dialog opts={pending.opts} onConfirm={resolve} onCancel={cancel} />;
}

interface DialogProps {
  readonly opts: ConfirmOptions;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

function Dialog({ opts, onConfirm, onCancel }: DialogProps): React.ReactElement {
  const title = opts.title ?? 'confirm';
  const confirmLabel = opts.confirmLabel ?? 'CONFIRM';
  const cancelLabel = opts.cancelLabel ?? 'CANCEL';
  // Initial focus on Cancel — Enter then commits to "do nothing", a safer
  // default for both `destructive` and `llm` confirms.
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelBtnRef.current?.focus();
  }, []);
  return (
    <DialogPortal>
      <Box
      role="dialog"
      aria-modal="true"
      aria-label={title}
      position="fixed"
      inset={0}
      bg="overlay"
      zIndex="modal"
      display="flex"
      alignItems="center"
      justifyContent="center"
      onClick={onCancel}
    >
      <Box
        onClick={(e): void => {
          e.stopPropagation();
        }}
        className="glass-strong"
        color="ink"
        w="440px"
        maxW="92vw"
        borderWidth="1px"
        borderRadius="lg"
        boxShadow="glassStrong"
      >
        <Flex
          align="center"
          gap="8px"
          px="14px"
          h="36px"
          borderBottomWidth="1px"
          borderColor="glass.line"
          bg="glass.panelSoft"
          backdropFilter="blur(12px)"
        >
          <Text
            fontFamily="mono"
            fontSize="xs"
            color="accent"
            fontWeight="700"
            letterSpacing="0.18em"
          >
            !
          </Text>
          <Text
            fontFamily="mono"
            fontSize="xs"
            color="ink2"
            letterSpacing="0.18em"
            textTransform="uppercase"
          >
            {title}
          </Text>
        </Flex>
        <Box px="16px" py="14px" fontFamily="mono" fontSize="sm" color="ink2" lineHeight="1.7">
          {opts.message}
        </Box>
        <Flex
          align="center"
          gap="8px"
          px="14px"
          py="10px"
          borderTopWidth="1px"
          borderColor="glass.line"
          bg="glass.panelSoft"
          backdropFilter="blur(12px)"
        >
          <Button
            ref={cancelBtnRef}
            onClick={onCancel}
            bg="transparent"
            color="ink2"
            borderWidth="1px"
            borderColor="line"
            h="auto"
            px="14px"
            py="6px"
            fontFamily="mono"
            fontSize="xs"
            letterSpacing="0.18em"
            borderRadius="sm"
            _hover={{ borderColor: 'ink2' }}
          >
            {cancelLabel}
          </Button>
          <Button
            ml="auto"
            onClick={onConfirm}
            bg="accent"
            color="panel"
            h="auto"
            px="16px"
            py="6px"
            fontFamily="mono"
            fontSize="xs"
            fontWeight="700"
            letterSpacing="0.18em"
            borderRadius="sm"
            _hover={{ bg: 'accent', opacity: 0.85 }}
          >
            {confirmLabel}
          </Button>
        </Flex>
      </Box>
    </Box>
    </DialogPortal>
  );
}
