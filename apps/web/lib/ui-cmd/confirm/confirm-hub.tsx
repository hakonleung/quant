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
import { useEffect } from 'react';

import { useFocusStore } from '../store/focus.js';
import { useConfirmHubStore, type ConfirmOptions } from './store.js';

export function ConfirmHub(): React.ReactElement | null {
  const pending = useConfirmHubStore((s) => s.pending);
  const resolve = useConfirmHubStore((s) => s.resolvePending);
  const cancel = useConfirmHubStore((s) => s.cancelPending);
  const setModalOpen = useFocusStore((s) => s.setModalOpen);

  // Mirror dialog presence into the keyboard engine's `modalOpen` so
  // Esc → closeModal lands here when no fullscreen / sequence buffer.
  useEffect(() => {
    setModalOpen(pending !== null);
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
  return (
    <Box
      role="dialog"
      aria-modal="true"
      aria-label={title}
      position="fixed"
      inset={0}
      bg="rgba(0,0,0,0.45)"
      zIndex={2000}
      display="flex"
      alignItems="center"
      justifyContent="center"
      onClick={onCancel}
    >
      <Box
        onClick={(e): void => {
          e.stopPropagation();
        }}
        bg="panel"
        color="ink"
        w="440px"
        maxW="92vw"
        borderWidth="1px"
        borderColor="accent"
        boxShadow="0 14px 48px rgba(0,0,0,0.55)"
      >
        <Flex
          align="center"
          gap="8px"
          px="14px"
          h="36px"
          borderBottomWidth="1px"
          borderColor="line"
          bg="panel3"
        >
          <Text
            fontFamily="mono"
            fontSize="11px"
            color="accent"
            fontWeight="700"
            letterSpacing="0.18em"
          >
            !
          </Text>
          <Text
            fontFamily="mono"
            fontSize="11px"
            color="ink2"
            letterSpacing="0.18em"
            textTransform="uppercase"
          >
            {title}
          </Text>
        </Flex>
        <Box px="16px" py="14px" fontFamily="mono" fontSize="12px" color="ink2" lineHeight="1.7">
          {opts.message}
        </Box>
        <Flex
          align="center"
          gap="8px"
          px="14px"
          py="10px"
          borderTopWidth="1px"
          borderColor="line"
          bg="panel3"
        >
          <Button
            onClick={onCancel}
            bg="transparent"
            color="ink2"
            borderWidth="1px"
            borderColor="line"
            h="auto"
            px="14px"
            py="6px"
            fontFamily="mono"
            fontSize="11px"
            letterSpacing="0.18em"
            borderRadius="0"
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
            fontSize="11px"
            fontWeight="700"
            letterSpacing="0.18em"
            borderRadius="0"
            _hover={{ bg: 'accentDark' }}
          >
            {confirmLabel}
          </Button>
        </Flex>
      </Box>
    </Box>
  );
}
