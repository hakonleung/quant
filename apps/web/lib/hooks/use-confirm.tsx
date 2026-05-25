'use client';

import { Box, Button, Flex, Text } from '@chakra-ui/react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

export interface ConfirmOptions {
  readonly title?: string;
  readonly message: ReactNode;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
}

export class ConfirmCancelled extends Error {
  constructor() {
    super('confirm cancelled');
    this.name = 'ConfirmCancelled';
  }
}

interface PendingState {
  readonly opts: ConfirmOptions;
  readonly resolve: () => void;
  readonly reject: (e: ConfirmCancelled) => void;
}

interface UseConfirm {
  readonly guard: (opts: ConfirmOptions) => Promise<void>;
  readonly comp: ReactNode;
}

export function useConfirm(): UseConfirm {
  const [pending, setPending] = useState<PendingState | null>(null);
  const pendingRef = useRef<PendingState | null>(null);
  pendingRef.current = pending;

  const guard = useCallback(
    (opts: ConfirmOptions): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        const prev = pendingRef.current;
        if (prev !== null) prev.reject(new ConfirmCancelled());
        setPending({ opts, resolve, reject });
      }),
    [],
  );

  const onConfirm = useCallback((): void => {
    const p = pendingRef.current;
    if (p === null) return;
    setPending(null);
    p.resolve();
  }, []);

  const onCancel = useCallback((): void => {
    const p = pendingRef.current;
    if (p === null) return;
    setPending(null);
    p.reject(new ConfirmCancelled());
  }, []);

  const comp =
    pending === null ? null : (
      <ConfirmDialog opts={pending.opts} onConfirm={onConfirm} onCancel={onCancel} />
    );

  return { guard, comp };
}

interface DialogProps {
  readonly opts: ConfirmOptions;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

function ConfirmDialog({ opts, onConfirm, onCancel }: DialogProps): React.ReactElement {
  const title = opts.title ?? 'confirm';
  const confirmLabel = opts.confirmLabel ?? 'CONFIRM';
  const cancelLabel = opts.cancelLabel ?? 'CANCEL';
  // Auto-focus the Cancel button on mount so keyboard users land in a
  // predictable position. Cancel (not Confirm) is the safer default for
  // destructive prompts — accidental Enter cancels rather than commits.
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelBtnRef.current?.focus();
  }, []);
  return (
    <Box
      role="dialog"
      aria-modal="true"
      aria-label={title}
      position="fixed"
      inset={0}
      bg="overlay"
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
        boxShadow="card"
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
            _hover={{ bg: 'accent', opacity: 0.85 }}
          >
            {confirmLabel}
          </Button>
        </Flex>
      </Box>
    </Box>
  );
}
