'use client';

/**
 * Reusable xterm-backed terminal pane.
 *
 * Hosts the engine (via `useTermConsole`) plus the optional line-number
 * gutter. Parent components drive it programmatically through the
 * forwarded ref (`runCommand`, `focus`) and observe state through
 * `onState` if they need to mirror phase to status chrome.
 *
 * Surface map:
 *   - TERM.MAIN: fontSize 15, no gutter, default banner.
 *   - AI.EQ / AI.SEC: fontSize 12, gutter on, no banner, autoRun fills
 *     `analyze code=...` / `analyze.sector id=...` to render cached
 *     payload on mount.
 */

import { Box, Flex } from '@chakra-ui/react';
import type { TerminalState } from '@quant/terminal';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';

import { LineNumberGutter } from './line-number-gutter.js';
import { useTermConsole, type InitialOutput } from './use-term-console.js';

export interface TermConsoleProps {
  readonly fontSize?: number;
  readonly showLineNumbers?: boolean;
  readonly banner?: string;
  /**
   * Grab keyboard focus on mount. Required for whole-screen surfaces
   * (TERM.MAIN). Embedded panes (AI.EQ / AI.SEC) must leave this off
   * so adjacent features keep their keyboard. Default: false.
   */
  readonly autoFocus?: boolean;
  /** Pre-fill the command buffer (not executed). */
  readonly initialBuffer?: string;
  /** Inject a one-shot output entry on mount (no command run). */
  readonly initialOutput?: InitialOutput;
  readonly onState?: (state: TerminalState) => void;
}

export interface TermConsoleHandle {
  readonly runCommand: (line: string) => void;
  readonly focus: () => void;
}

const DEFAULT_BANNER = 'qX//OS terminal · type `help` to get started';

export const TermConsole = forwardRef<TermConsoleHandle, TermConsoleProps>(function TermConsole(
  {
    fontSize = 15,
    showLineNumbers = false,
    banner = DEFAULT_BANNER,
    autoFocus = false,
    initialBuffer,
    initialOutput,
    onState,
  },
  ref,
): React.ReactElement {
  const bridge = useTermConsole({
    fontSize,
    banner,
    autoFocus,
    ...(initialBuffer !== undefined ? { initialBuffer } : {}),
    ...(initialOutput !== undefined ? { initialOutput } : {}),
  });
  const { mount, unmount, runCommand, focus, state, termRef } = bridge;
  const lastNodeRef = useRef<HTMLDivElement | null>(null);
  const mountedRef = useRef<boolean>(false);
  const onStateRef = useRef<typeof onState>(onState);
  onStateRef.current = onState;

  useEffect(() => {
    onStateRef.current?.(state);
  }, [state]);

  const hostRefCallback = useCallback(
    (node: HTMLDivElement | null): void => {
      if (node === lastNodeRef.current) return;
      if (lastNodeRef.current !== null) {
        unmount();
        mountedRef.current = false;
      }
      lastNodeRef.current = node;
      if (node !== null) {
        mount(node);
        mountedRef.current = true;
      }
    },
    [mount, unmount],
  );

  useImperativeHandle(
    ref,
    () => ({
      runCommand,
      focus,
    }),
    [runCommand, focus],
  );

  return (
    <Flex
      h="100%"
      minH={0}
      bg="term.bg"
      position="relative"
      backdropFilter="blur(20px) saturate(180%)"
      css={{ WebkitBackdropFilter: 'blur(20px) saturate(180%)' }}
    >
      {showLineNumbers && (
        <LineNumberGutter termRef={termRef} fontSize={fontSize} mounted={mountedRef.current} />
      )}
      <Box
        ref={hostRefCallback}
        flex="1"
        minW={0}
        minH={0}
        position="relative"
        tabIndex={0}
        onClick={(): void => {
          lastNodeRef.current
            ?.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
            ?.focus();
        }}
      />
    </Flex>
  );
});
