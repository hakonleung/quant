'use client';

/**
 * Container-query helper — track a host element's width via
 * `ResizeObserver` so a Feat can pick a layout based on the column it
 * was placed in, not the viewport.
 *
 * Use this when a Feat lives inside a resizable column (right column
 * on desktop = 280–720 px; same Feat in mobile fills the whole 320–
 * 768 px viewport): the breakpoint that matters is the host width,
 * not `window.innerWidth`. Pair with `useViewport()` only when the
 * decision genuinely depends on the device class, not the box.
 *
 * SSR: returns `0` until the first effect runs. Components that read
 * the width should treat 0 as "unknown" and render the most generous
 * layout (or a one-frame skeleton) so the server-rendered HTML stays
 * indistinguishable from the first client paint.
 */

import { useEffect, useRef, useState, type RefObject } from 'react';

export interface ContainerWidth {
  readonly ref: RefObject<HTMLDivElement>;
  readonly width: number;
}

export function useContainerWidth(): ContainerWidth {
  // `useRef<HTMLDivElement>(null)` yields `RefObject<HTMLDivElement>`
  // (React 18 typing) which is what Chakra's `Box ref={…}` accepts.
  // The `.current` is still typed as nullable internally, which is
  // safe because we only read it after mount inside the effect.
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    // Seed from the synchronous value so the first paint isn't a
    // 0-width skeleton when the parent already laid out.
    setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry === undefined) return;
      // contentBoxSize when available is more accurate than
      // contentRect on devices that scale the device pixel ratio.
      const inline = entry.contentBoxSize[0]?.inlineSize;
      setWidth(inline ?? entry.contentRect.width);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, []);
  return { ref, width };
}
