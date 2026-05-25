'use client';

/**
 * Sibling gutter painting 1-based line numbers aligned to xterm row
 * heights. xterm itself has no line-number affordance, so we render a
 * left-side column whose row pitch matches the xterm font metrics
 * (fontSize * lineHeight). The visible row count is derived from the
 * gutter's own clientHeight, NOT from `term.rows`, so the column fills
 * the container height even before xterm has finished its first fit
 * cycle.
 *
 * Numeric base tracks `term.buffer.active.viewportY` — as the user
 * scrolls or content is appended, the displayed numbers advance with
 * the viewport, so a stable absolute coordinate is visible at all
 * times. No padding/margin is applied: the first gutter row sits at
 * y=0 of the column, matching xterm's `.xterm-rows` which also starts
 * at y=0 of its container.
 */

import { Box } from '@chakra-ui/react';
import type { Terminal } from '@xterm/xterm';
import { useEffect, useRef, useState } from 'react';

interface Props {
  readonly termRef: React.MutableRefObject<Terminal | null>;
  readonly fontSize: number;
  readonly mounted: boolean;
}

const LINE_HEIGHT_RATIO = 1.2;

export function LineNumberGutter({
  termRef,
  fontSize,
  mounted,
}: Props): React.ReactElement {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [viewportY, setViewportY] = useState<number>(0);
  const [hostHeight, setHostHeight] = useState<number>(0);

  useEffect(() => {
    const node = hostRef.current;
    if (node === null) return;
    setHostHeight(node.clientHeight);
    const ro = new ResizeObserver(() => {
      setHostHeight(node.clientHeight);
    });
    ro.observe(node);
    return () => {
      ro.disconnect();
    };
  }, []);

  useEffect(() => {
    if (!mounted) return;
    const term = termRef.current;
    if (term === null) return;
    const refresh = (): void => {
      setViewportY(term.buffer.active.viewportY);
    };
    refresh();
    const disposers: { dispose: () => void }[] = [];
    disposers.push(term.onScroll(refresh));
    disposers.push(term.onWriteParsed(refresh));
    disposers.push(term.onResize(refresh));
    return () => {
      for (const d of disposers) {
        try {
          d.dispose();
        } catch {
          /* */
        }
      }
    };
  }, [termRef, mounted]);

  const rowHeight = fontSize * LINE_HEIGHT_RATIO;
  const rowCount = Math.max(1, Math.floor(hostHeight / rowHeight));
  const lastNumber = viewportY + rowCount;
  const digits = Math.max(3, String(lastNumber).length);

  return (
    <Box
      ref={hostRef}
      flexShrink={0}
      bg="term.bg"
      color="term.ink3"
      fontFamily='"Monaspace Neon", "JetBrains Mono", "SF Mono", ui-monospace, Menlo, monospace'
      fontSize={`${String(fontSize)}px`}
      lineHeight={`${String(rowHeight)}px`}
      userSelect="none"
      textAlign="right"
      minW={`${String(digits + 2)}ch`}
      overflow="hidden"
      borderRightWidth="1px"
      borderRightColor="brand.termGlowBorder"
      pl="6px"
      pr="8px"
    >
      {Array.from({ length: rowCount }).map((_, i) => {
        const n = viewportY + i + 1;
        return (
          <Box
            key={i}
            h={`${String(rowHeight)}px`}
            lineHeight={`${String(rowHeight)}px`}
          >
            {String(n).padStart(digits, '0')}
          </Box>
        );
      })}
    </Box>
  );
}
