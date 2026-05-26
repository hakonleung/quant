'use client';

/**
 * `<FloatingSurface>` — shared glass shell for off-grid surfaces
 * (dialogs, overlay bodies, the floating dock's children) so they
 * inherit the same look as the inline pane container: transparent
 * bg + backdrop-filter + a hairline glass border, no drop-shadow.
 *
 * Pairs with `<FeatSectionBar>` for headers (semi-transparent
 * `glass.panelSoft`) — the surface itself never tints the canvas;
 * tint comes from the header strip and from whatever the consumer
 * puts in the body. This keeps every floating layer reading as the
 * same material as the FeatView panes.
 *
 * Cyber variant swaps the border to `term.line` so terminal-skinned
 * dialogs (none today, kept for parity) stay coherent.
 */

import { Box, type BoxProps } from '@chakra-ui/react';
import { forwardRef, type Ref } from 'react';

type FloatingSurfaceProps = BoxProps & {
  readonly cyber?: boolean;
};

export const FloatingSurface = forwardRef<HTMLDivElement, FloatingSurfaceProps>(
  function FloatingSurface(
    { cyber = false, children, ...rest }: FloatingSurfaceProps,
    ref: Ref<HTMLDivElement>,
  ): React.ReactElement {
    return (
      <Box
        ref={ref}
        bg="transparent"
        backdropFilter="blur(16px) saturate(180%)"
        borderWidth="1px"
        borderColor={cyber ? 'term.line' : 'glass.line'}
        borderRadius="xs"
        boxShadow="none"
        color={cyber ? 'term.ink2' : 'ink'}
        overflow="hidden"
        {...rest}
      >
        {children}
      </Box>
    );
  },
);

