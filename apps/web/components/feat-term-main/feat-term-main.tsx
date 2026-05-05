'use client';

/**
 * TERM.MAIN — keyboard-driven command surface.
 *
 * The body holds an xterm.js host element managed by `useTerminal`. The
 * outer chrome / minimize / fullscreen behavior is provided by `FeatView`,
 * which reshapes its JSX (single element → fragment with placeholder)
 * when entering fullscreen. That reshape unmounts the previous pane
 * subtree and mounts a fresh one, so we cannot use `useEffect` keyed on
 * `[mount, unmount]` (its deps never change). A ref callback fires on
 * every DOM-node identity change, which is what we need: detach xterm
 * from the old node and re-attach to the new one.
 */

import { Box } from '@chakra-ui/react';
import { useCallback, useRef } from 'react';

import { Feat } from '../../lib/eqty/feat.js';
import { FeatView } from '../feat-view/feat-view.js';
import { useTerminal } from './use-terminal.js';

export function FeatTermMain(): React.ReactElement {
  const { mount, unmount } = useTerminal();
  const lastNodeRef = useRef<HTMLDivElement | null>(null);

  const hostRefCallback = useCallback(
    (node: HTMLDivElement | null): void => {
      if (node === lastNodeRef.current) return;
      if (lastNodeRef.current !== null) {
        unmount();
      }
      lastNodeRef.current = node;
      if (node !== null) {
        mount(node);
      }
    },
    [mount, unmount],
  );

  return (
    <FeatView feat={Feat.Terminal}>
      <Box
        ref={hostRefCallback}
        h="100%"
        minH="320px"
        bg="term.bg"
        position="relative"
        // xterm requires a tabindex for focus on click.
        tabIndex={0}
        onClick={(): void => {
          lastNodeRef.current
            ?.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea')
            ?.focus();
        }}
      />
    </FeatView>
  );
}
