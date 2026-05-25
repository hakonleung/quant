'use client';

/**
 * Swiper-style horizontal carousel for the SEC.LIST chip strip.
 *
 * Behaviour (modeled on swiper.js but without the dependency):
 *
 *   - **Drag-to-pan**: mouse-down + drag scrolls the strip horizontally.
 *     Window-level move/up listeners keep the gesture alive even when
 *     the cursor leaves the strip — same UX trick as `chart-canvas.tsx`.
 *     A small drag threshold (4 px) suppresses click events triggered by
 *     a drag, so accidental wiggles don't switch the active sector.
 *   - **Snap**: each child gets `scroll-snap-align: start`, so wheel /
 *     touchpad scrolling lands cleanly on chip boundaries.
 *   - **Nav buttons**: chevron pills on each edge fade in only when
 *     there's actually overflow on that side. Clicking advances the
 *     viewport by ~80% of its width so the next "page" of chips slides
 *     in with one chip of overlap for context.
 *   - **Hidden scrollbar**: the host scrollbar is collapsed visually
 *     (`scrollbar-width: none` + `::-webkit-scrollbar { display: none }`)
 *     because the chevron pills are the canonical affordance.
 *
 * The component is purely presentational — caller owns the children
 * (chips) and any selection state. Children must be siblings of
 * `<SectorSwiper>`'s implicit scroll viewport; the swiper does not
 * impose styling beyond `scroll-snap-align`.
 */

import { Box, Flex } from '@chakra-ui/react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

interface Props {
  /** Children render inline-row inside the scroll viewport. */
  readonly children: ReactNode;
  /** Pixel height for the viewport row. Default 40. */
  readonly height?: number;
}

/** Drag distance (px) below which we treat the gesture as a click. */
const DRAG_CLICK_THRESHOLD = 4;
/** Fraction of viewport width to advance per chevron click. */
const PAGE_FRACTION = 0.8;

export function SectorSwiper({ children, height = 40 }: Props): React.ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canPrev, setCanPrev] = useState(false);
  const [canNext, setCanNext] = useState(false);
  const dragRef = useRef<{
    startClientX: number;
    startScrollLeft: number;
    moved: boolean;
  } | null>(null);

  const recomputeEdges = useCallback((): void => {
    const el = scrollRef.current;
    if (el === null) return;
    const max = el.scrollWidth - el.clientWidth;
    setCanPrev(el.scrollLeft > 1);
    setCanNext(el.scrollLeft < max - 1);
  }, []);

  // Keep edge-state in sync with scroll position, viewport size, and
  // child-count changes. ResizeObserver covers width changes; the inner
  // MutationObserver catches chips added / removed without re-render.
  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    recomputeEdges();
    const ro = new ResizeObserver(recomputeEdges);
    ro.observe(el);
    const mo = new MutationObserver(recomputeEdges);
    mo.observe(el, { childList: true, subtree: true });
    el.addEventListener('scroll', recomputeEdges, { passive: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
      el.removeEventListener('scroll', recomputeEdges);
    };
  }, [recomputeEdges]);

  // Window-level mouse handlers so the drag gesture survives leaving
  // the swiper bounds (mirrors chart-canvas.tsx's drag pattern).
  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      const drag = dragRef.current;
      if (drag === null) return;
      const dx = e.clientX - drag.startClientX;
      if (Math.abs(dx) > DRAG_CLICK_THRESHOLD) drag.moved = true;
      const el = scrollRef.current;
      if (el !== null) el.scrollLeft = drag.startScrollLeft - dx;
    };
    const onUp = (): void => {
      const drag = dragRef.current;
      if (drag === null) return;
      // Defer the "click cancel" reset by one frame so the bubbling
      // click event sees `moved` and short-circuits.
      if (drag.moved) {
        requestAnimationFrame(() => {
          dragRef.current = null;
        });
      } else {
        dragRef.current = null;
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>): void => {
    // Ignore secondary buttons and clicks that originate on a button
    // (the per-chip delete, etc.) — those have their own handlers.
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('button') !== null) return;
    const el = scrollRef.current;
    if (el === null) return;
    dragRef.current = {
      startClientX: e.clientX,
      startScrollLeft: el.scrollLeft,
      moved: false,
    };
  };

  // Capture-phase click guard — if the gesture moved further than the
  // threshold, swallow the click so chips don't fire onClick.
  const onClickCapture = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (dragRef.current?.moved === true) {
      e.stopPropagation();
      e.preventDefault();
    }
  };

  const advance = (dir: 1 | -1): void => {
    const el = scrollRef.current;
    if (el === null) return;
    const step = Math.max(120, el.clientWidth * PAGE_FRACTION);
    el.scrollBy({ left: dir * step, behavior: 'smooth' });
  };

  return (
    <Box position="relative" h={`${String(height)}px`} bg="panel">
      <Flex
        ref={scrollRef}
        as="ul"
        listStyleType="none"
        m={0}
        p={0}
        h="100%"
        align="stretch"
        gap="1px"
        overflowX="auto"
        overflowY="hidden"
        cursor={dragRef.current === null ? 'grab' : 'grabbing'}
        onMouseDown={onMouseDown}
        onClickCapture={onClickCapture}
        css={{
          scrollSnapType: 'x proximity',
          // Strip the scrollbar — chevron pills are the affordance.
          scrollbarWidth: 'none',
          '::-webkit-scrollbar': { display: 'none' },
          // Anything inside aligned to its leading edge.
          '& > *': { scrollSnapAlign: 'start' },
        }}
      >
        {children}
      </Flex>
      {/* Edge fades — gradient overlays on each side that hint at
          scrollable content beyond the chevron pill. They light up
          only when the corresponding direction is actually available
          so a fully-scrolled-to-end strip doesn't draw a phantom
          shadow. `pointer-events: none` keeps clicks falling through
          to the chips underneath. */}
      {canPrev && <EdgeFade side="left" />}
      {canNext && <EdgeFade side="right" />}
      {canPrev && (
        <NavPill
          dir="prev"
          onClick={(): void => {
            advance(-1);
          }}
        />
      )}
      {canNext && (
        <NavPill
          dir="next"
          onClick={(): void => {
            advance(1);
          }}
        />
      )}
    </Box>
  );
}

function EdgeFade({ side }: { readonly side: 'left' | 'right' }): React.ReactElement {
  return (
    <Box
      position="absolute"
      top={0}
      bottom={0}
      width="36px"
      left={side === 'left' ? 0 : 'auto'}
      right={side === 'right' ? 0 : 'auto'}
      pointerEvents="none"
      zIndex={0}
      aria-hidden="true"
      style={{
        background:
          side === 'left'
            ? 'linear-gradient(to right, var(--chakra-colors-panel) 0%, rgba(0,0,0,0) 100%)'
            : 'linear-gradient(to left, var(--chakra-colors-panel) 0%, rgba(0,0,0,0) 100%)',
      }}
    />
  );
}

interface NavPillProps {
  readonly dir: 'prev' | 'next';
  readonly onClick: () => void;
}

/**
 * Chevron pill anchored to one edge of the swiper. Pointer events on
 * the button take precedence over the drag handler thanks to the
 * `closest('button')` check in `onMouseDown`.
 */
function NavPill({ dir, onClick }: NavPillProps): React.ReactElement {
  const isPrev = dir === 'prev';
  return (
    <Box
      as="button"
      aria-label={isPrev ? 'scroll left' : 'scroll right'}
      onClick={onClick}
      position="absolute"
      top="50%"
      left={isPrev ? '0' : 'auto'}
      right={isPrev ? 'auto' : '0'}
      transform="translateY(-50%)"
      h="28px"
      w="22px"
      bg="brand.panelAlpha"
      color="ink2"
      borderWidth="1px"
      borderColor="line"
      borderRadius="2px"
      fontFamily="mono"
      fontSize="14px"
      fontWeight="700"
      lineHeight="1"
      display="grid"
      placeItems="center"
      cursor="pointer"
      _hover={{ bg: 'brand.panelAlpha', color: 'accent', borderColor: 'accent' }}
      // Render above scroll-snap content but inside the swiper box so
      // hit-testing stays predictable.
      zIndex={1}
    >
      {isPrev ? '‹' : '›'}
    </Box>
  );
}
