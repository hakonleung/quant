'use client';

/**
 * CRT background — two stacked absolute-positioned layers that sit
 * behind every other child of the terminal pane:
 *
 *   1. fine-grained green grid (subtle perspective lines)
 *   2. horizontal scanlines (3px repeating gradient)
 *
 * Pure presentation, no IO, no state. Drops into the terminal area
 * with `pointer-events: none` so it never intercepts clicks.
 */

import { Box } from '@chakra-ui/react';

export function CrtOverlay(): React.ReactElement {
  return (
    <>
      <Box
        position="absolute"
        inset="0"
        pointerEvents="none"
        zIndex={0}
        backgroundImage="linear-gradient(rgba(94,255,156,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(94,255,156,0.06) 1px, transparent 1px)"
        backgroundSize="24px 24px"
        opacity={0.55}
      />
      <Box
        position="absolute"
        inset="0"
        pointerEvents="none"
        zIndex={0}
        backgroundImage="repeating-linear-gradient(0deg, rgba(0,0,0,0.18) 0px, rgba(0,0,0,0.18) 1px, transparent 1px, transparent 3px)"
        opacity={0.7}
      />
      <Box
        position="absolute"
        inset="0"
        pointerEvents="none"
        zIndex={0}
        background="radial-gradient(ellipse at center, transparent 60%, rgba(0,0,0,0.45) 100%)"
      />
    </>
  );
}
