'use client';

/**
 * `MonoButton` — single-glyph mono icon button.
 *
 * Wraps Chakra's `Button` via the `monoButton` recipe registered in
 * `apps/web/lib/theme/system.ts`. Pane chrome buttons (FeatView
 * minimize / fullscreen / restore controls and action slots) all flow
 * through this so the hot-zone size, focus ring, and hover transition
 * are defined once.
 */

import { Button, type ButtonProps, useRecipe } from '@chakra-ui/react';
import { forwardRef, type ReactNode } from 'react';

interface MonoButtonProps extends Omit<ButtonProps, 'children' | 'size' | 'variant'> {
  readonly label: string;
  readonly children: ReactNode;
  readonly size?: 'sm' | 'md';
}

export const MonoButton = forwardRef<HTMLButtonElement, MonoButtonProps>(function MonoButton(
  { label, children, size, ...rest },
  ref,
) {
  const recipe = useRecipe({ key: 'monoButton' });
  const styles = recipe(size === undefined ? {} : { size });
  return (
    <Button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      css={styles}
      {...rest}
    >
      {children}
    </Button>
  );
});
