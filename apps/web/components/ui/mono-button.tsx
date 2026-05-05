'use client';

/**
 * `MonoButton` — single-glyph mono icon button.
 *
 * Wraps Chakra's `Button` via the `monoButton` recipe registered in
 * `apps/web/lib/theme/system.ts`. Icons are addressed by semantic
 * key (`icon="add"`) and the glyph + per-glyph base scale live in the
 * `MONO_ICON_MAP` registry below — callers never spell out raw mono
 * glyphs so the chrome stays consistent across panes. `children` is
 * rendered to the right of the glyph for buttons that pair an icon
 * with a label.
 */

import { Button, type ButtonProps, Span, useRecipe } from '@chakra-ui/react';
import { forwardRef, type ReactNode } from 'react';

interface MonoIconConfig {
  /** The mono glyph rendered inside the button. */
  readonly glyph: string;
  /** Per-glyph base scale — used to even out visual size across
   *  glyphs whose typographic metrics differ (eg. `+` and `⛶`). The
   *  hover-scale animation is layered on top of this. */
  readonly scale?: number;
  readonly mt?: number;
}

/**
 * One entry per unique glyph. Key naming follows the *glyph*, not the
 * action — eg. `+` is `add` whether it's "new sector" or "zoom in", and
 * `×` is `delete` whether it's "remove" or "clear". Reusing a glyph for
 * different actions doesn't create a duplicate entry; the caller picks
 * the existing key and supplies its own `label` for the action.
 */
export const MONO_ICON_MAP = {
  search: { glyph: '⌕', scale: 1.5 },
  refresh: { glyph: '⟳', scale: 1.4 },
  star: { glyph: '★', scale: 1.4, mt: -1 },
  block: { glyph: '⊘', scale: 1.2 },
  push: { glyph: '▶', scale: 0.95 },

  add: { glyph: '+' },
  minimize: { glyph: '—' },
  delete: { glyph: '×' },
  fullscreen: { glyph: '⛶' },
  exitFullscreen: { glyph: '◱' },
  restore: { glyph: '▢', scale: 1.1, mt: -0.5 },
  up: { glyph: '↑' },
  down: { glyph: '↓' },
} as const satisfies Record<string, MonoIconConfig>;

export type MonoIconKey = keyof typeof MONO_ICON_MAP;

interface MonoButtonProps extends Omit<
  ButtonProps,
  'children' | 'size' | 'variant' | 'aria-label' | 'title'
> {
  readonly icon: MonoIconKey;
  readonly label: string;
  readonly size?: 'sm' | 'md';
  /** Optional content rendered to the right of the icon — eg. a
   *  short text label. The hover scale applies to the whole button
   *  so the icon and text grow together. */
  readonly children?: ReactNode;
}

export const MonoButton = forwardRef<HTMLButtonElement, MonoButtonProps>(function MonoButton(
  { icon, label, size, children, ...rest },
  ref,
) {
  const recipe = useRecipe({ key: 'monoButton' });
  const styles = recipe(size === undefined ? {} : { size });
  const cfg = MONO_ICON_MAP[icon];
  return (
    <Button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      css={{
        ...styles,
        // When the button has children we let it grow horizontally;
        // pure-icon buttons keep the square hot-zone defined by the
        // recipe size variant.
        ...(children !== undefined
          ? {
              width: 'auto',
              gap: '6px',
              paddingInline: '6px',
              gridAutoFlow: 'column',
              gridTemplateColumns: 'auto auto',
            }
          : {}),
      }}
      {...rest}
    >
      <Span
        style={{
          display: 'inline-block',
          transform: `scale(${String('scale' in cfg ? cfg.scale : 1)})`,
          transformOrigin: 'center',
          lineHeight: 1,
        }}
        mt={'mt' in cfg ? cfg.mt : undefined}
      >
        {cfg.glyph}
      </Span>
      {children}
    </Button>
  );
});
