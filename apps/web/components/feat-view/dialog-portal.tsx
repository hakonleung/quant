'use client';

/**
 * `<DialogPortal>` — wraps modal/dialog content in a React portal to
 * `document.body`, escaping any parent `backdrop-filter` containing
 * block.
 *
 * **Why this exists.** CSS spec: a non-`none` `backdrop-filter` value
 * establishes a containing block for fixed-positioned descendants.
 * Our `FeatView` panes apply backdrop-filter (for the Liquid Glass
 * look) — that means any Dialog mounted as a React child of a
 * FeatView would have its `position: fixed` resolved relative to the
 * FeatView pane rather than the viewport, clipping the dialog to a
 * tiny rectangle in the corner.
 *
 * SSR-safe: returns children unwrapped when `document` isn't defined.
 */

import type { ReactNode, ReactElement } from 'react';
import { createPortal } from 'react-dom';

export function DialogPortal({ children }: { readonly children: ReactNode }): ReactElement {
  if (typeof document === 'undefined') return <>{children}</>;
  return createPortal(<>{children}</>, document.body);
}
