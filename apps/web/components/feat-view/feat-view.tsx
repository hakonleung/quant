'use client';

import { Box, Flex, HStack } from '@chakra-ui/react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal, flushSync } from 'react-dom';

import { FEAT_CONFIG_MAP, type Feat } from '../../lib/eqty/feat.js';
import { useLayoutStore, type FeatViewMode } from '../../lib/stores/layout.store.js';
import { MonoButton } from '../ui/mono-button.js';
import { FeatViewStatus, type FeatViewStatusTone } from './feat-view-header.js';
import { FloatingSurface } from './floating-surface.js';

const TRANSITION_MS = 280;

/** Returns true when the user has asked for reduced motion. SSR-safe. */
const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Fullscreen geometry — the pane sits BELOW the topbar so brand / SYS /
// USR / theme toggle stay reachable (Apple HIG: full-window apps keep
// the menu bar). The same values drive both the static CSS style and
// the WAAPI keyframe endpoints so the animation lands exactly where
// CSS takes over — without this match the pane jumps the difference
// between `top: 0` (old keyframe end) and `top: 52px` (CSS) at the end
// of the animation.
const FULLSCREEN_TOP = 'calc(var(--app-topbar-h, 52px) + env(safe-area-inset-top))';
const FULLSCREEN_HEIGHT = 'calc(100dvh - var(--app-topbar-h, 52px) - env(safe-area-inset-top))';
const FULLSCREEN_KEYFRAME = {
  top: FULLSCREEN_TOP,
  left: '0px',
  width: '100vw',
  height: FULLSCREEN_HEIGHT,
} as const;

/**
 * Inline styles applied to the pane when it switches to fullscreen.
 *
 * z-index uses the unified `fullscreen` token (1500) — above
 * overlay/dialog/scrim but below toast/hint/tooltip so transient
 * messages can still surface.
 */
const FULLSCREEN_STYLE = {
  top: FULLSCREEN_TOP,
  left: 0,
  width: '100vw',
  height: FULLSCREEN_HEIGHT,
  zIndex: 'var(--chakra-z-index-fullscreen, 1500)',
  paddingBottom: 'env(safe-area-inset-bottom)',
} as const;

interface FeatViewProps {
  readonly feat: Feat;
  /** Status pellet rendered between the id and the title slot — only
   *  paints for non-normal tones (see :class:`FeatViewStatus`). */
  readonly status?: FeatViewStatusTone;
  readonly statusBlink?: boolean;
  /** Custom title slot — when present takes the whole title position. */
  readonly titleSlot?: ReactNode;
  readonly right?: ReactNode;
  /**
   * When true, the pane sizes to its content rather than flex-growing
   * to fill the column. Use for compact panes (single-row sliders,
   * thin status strips) that would otherwise stretch and starve the
   * panes below them in the same column.
   */
  readonly contentSized?: boolean;
  /**
   * Embedded mode: skip the FeatView chrome (header, status, controls,
   * minimize/fullscreen state) entirely and just render `children`. Use
   * when a feat component needs to be hosted inside another FeatView
   * (e.g. as one of USR.MAIN's tabs) without doubling up on the pane
   * frame.
   */
  readonly bare?: boolean;
  readonly children: ReactNode;
}

export function FeatView({
  feat,
  status,
  statusBlink,
  titleSlot,
  right,
  contentSized,
  bare,
  children,
}: FeatViewProps): React.ReactElement {
  if (bare === true) return <>{children}</>;
  const config = FEAT_CONFIG_MAP[feat];
  const cyber = config.cyber ?? false;
  const bodyOverlay = config.bodyOverlay ?? false;
  const floating = config.floating ?? false;
  // Floating panes implicitly disallow fullscreen — they're already
  // outside the column grid, so growing edge-to-edge is meaningless.
  const allowFullscreen = !floating && config.noFullscreen !== true;
  // JSX prop overrides config so per-instance overrides still work
  // (e.g. mounting an otherwise content-sized Feat inside a slot that
  // wants it to fill).
  const isContentSized = contentSized ?? config.contentSized ?? false;

  // Persisted mode keyed by feat id — survives reloads. Missing entries
  // fall back to the static `defaultMinimized` flag in feat config.
  // Panes that disallow fullscreen (floating or noFullscreen) clamp
  // any stale `fullscreen` value to `normal` so a config flip after
  // release doesn't leave the pane stuck in an unreachable mode.
  const persistedMode = useLayoutStore((s) => s.featViewMode[feat]);
  const rawMode: FeatViewMode =
    persistedMode ?? (config.defaultMinimized === true ? 'minimized' : 'normal');
  const mode: FeatViewMode = !allowFullscreen && rawMode === 'fullscreen' ? 'normal' : rawMode;
  const setPersistedMode = useLayoutStore((s) => s.setFeatViewMode);
  const setMode = useCallback(
    (m: FeatViewMode): void => {
      setPersistedMode(feat, m);
    },
    [feat, setPersistedMode],
  );
  const paneRef = useRef<HTMLDivElement>(null);
  const placeholderRef = useRef<HTMLDivElement>(null);

  const goFullscreen = useCallback((): void => {
    const el = paneRef.current;
    if (el === null) return;
    const r = el.getBoundingClientRect();
    setMode('fullscreen');
    // Reduced-motion users skip the keyframe — the pane snaps to
    // fullscreen via the inline `position:fixed` switch alone.
    if (prefersReducedMotion()) return;
    // After the mode change paints (pane becomes position:fixed inset:0),
    // play a Web Animations keyframe from the starting rect →
    // fullscreen geometry. End keyframe MUST match `FULLSCREEN_STYLE`
    // exactly — otherwise the WAAPI animation handoff back to CSS at
    // `finish` causes a visible jump (we previously animated to `top:
    // 0` while CSS set `top: 52px`, so the pane snapped down by the
    // topbar height at the end of the animation).
    requestAnimationFrame(() => {
      const node = paneRef.current;
      if (node === null) return;
      node.animate(
        [
          {
            top: `${r.top}px`,
            left: `${r.left}px`,
            width: `${r.width}px`,
            height: `${r.height}px`,
          },
          { ...FULLSCREEN_KEYFRAME },
        ],
        { duration: TRANSITION_MS, easing: 'ease' },
      );
    });
  }, []);

  const exitFullscreen = useCallback((): void => {
    const ph = placeholderRef.current;
    const node = paneRef.current;
    if (ph === null || node === null) {
      setMode('normal');
      return;
    }
    if (prefersReducedMotion()) {
      // Same rationale as goFullscreen — instant transition keeps the
      // pane behaviour identical for assistive-tech users.
      setMode('normal');
      return;
    }
    const r = ph.getBoundingClientRect();
    // Start keyframe = current FULLSCREEN_STYLE values so the WAAPI
    // animation begins exactly where the rendered pane is right now.
    const anim = node.animate(
      [
        { ...FULLSCREEN_KEYFRAME },
        {
          top: `${r.top}px`,
          left: `${r.left}px`,
          width: `${r.width}px`,
          height: `${r.height}px`,
        },
      ],
      { duration: TRANSITION_MS, easing: 'ease', fill: 'forwards' },
    );
    anim.onfinish = (): void => {
      // Swap to normal mode synchronously so the inline `position:fixed`
      // styles are gone before we cancel the keyframe — otherwise the
      // pane briefly snaps back to the fullscreen rect on cancel.
      flushSync(() => {
        setMode('normal');
      });
      anim.cancel();
    };
  }, []);

  // FLIP-style toggle for min/restore. Snapshot the pane's height
  // BEFORE flushing the state change, then measure the new height
  // AFTER the synchronous re-layout — those two numbers are the
  // WAAPI endpoints. Inline `height` overrides flex sizing during the
  // animation; once it finishes (no `fill: forwards`), CSS reasserts
  // and the pane sits at whichever flex/max-height combination the
  // mode dictates.
  //
  // We deliberately ignore `prefers-reduced-motion` here — the
  // pane's expand/collapse is a load-bearing UI affordance (it's how
  // the user reads the layout transition). A 280 ms ease is mild
  // enough to stay below the typical reduced-motion threshold; the
  // fullscreen WAAPI animations elsewhere still respect the pref.
  const togglePane = useCallback(
    (next: 'minimized' | 'normal'): void => {
      const node = paneRef.current;
      if (node === null) {
        setMode(next);
        return;
      }
      const from = node.getBoundingClientRect().height;
      flushSync(() => {
        setMode(next);
      });
      const target = paneRef.current;
      if (target === null) return;
      const to = target.getBoundingClientRect().height;
      if (Math.abs(from - to) < 1) return;
      target.animate(
        [
          { height: `${String(from)}px`, overflow: 'hidden' },
          { height: `${String(to)}px`, overflow: 'hidden' },
        ],
        { duration: TRANSITION_MS, easing: 'ease' },
      );
    },
    [setMode],
  );

  const minimize = useCallback((): void => {
    togglePane('minimized');
  }, [togglePane]);

  const restore = useCallback((): void => {
    togglePane('normal');
  }, [togglePane]);

  // Esc exits fullscreen.
  useEffect(() => {
    if (mode !== 'fullscreen') return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        exitFullscreen();
      }
    };
    window.addEventListener('keydown', handler);
    return () => {
      window.removeEventListener('keydown', handler);
    };
  }, [mode, exitFullscreen]);

  const corners = {
    _before: cornerStyle('tl', cyber),
    _after: cornerStyle('br', cyber),
  } as const;

  const isFullscreen = mode === 'fullscreen';
  const isMinimized = mode === 'minimized';
  // In overlay mode the inline body collapses to nothing — the floating
  // dropdown takes over. Treating overlay-normal like minimized for
  // outer sizing keeps the host (e.g. the topbar) from reflowing when
  // the pane is restored.
  const overlayActive = bodyOverlay && !isMinimized && !isFullscreen;
  const inlineCollapsed = isMinimized || overlayActive;
  // Body overlay panes lose the max-height-collapse animation, so we
  // just unmount their children when minimized — keeps query
  // subscriptions / event listeners off when the user has put the pane
  // away.
  const renderInlineBody = !overlayActive && !(bodyOverlay && isMinimized);

  // The min/restore animation runs on the body wrapper's
  // `grid-template-rows`, interpolating `1fr ↔ 0fr`. The key insight
  // is that the wrapper KEEPS `flex: 1` constant — only the grid
  // fraction toggles. Switching `flex` together with the row size
  // would cause an instant flex-relayout that masks the row
  // transition.
  //
  // In normal mode the pane is `flex: 1` (fills column), wrapper is
  // `flex: 1` (fills pane minus header), grid row `1fr` = wrapper
  // height. In minimized mode the pane is `flex: 0 0 auto` (sizes to
  // content), wrapper is still `flex: 1` (indefinite parent → sizes
  // to content), grid row `0fr` = 0. Browser interpolates the fr
  // values per the CSS Grid spec (baseline in evergreen Chrome /
  // Safari 2024+); pane height follows from the wrapper's resolved
  // intrinsic height.

  const paneBox = (
    <Box
      ref={paneRef}
      // Liquid Glass — the container itself is transparent and only
      // applies the backdrop-filter. Tint comes from the semi-
      // transparent header; body is transparent. No box-shadow (the
      // wallpaper + border are enough to read the floating tile).
      bg="transparent"
      backdropFilter={'blur(16px) saturate(180%)'}
      borderWidth={isFullscreen ? 0 : '1px'}
      borderColor={cyber ? 'term.line' : 'glass.line'}
      borderRadius={isFullscreen ? 'none' : 'xs'}
      // Smooth chrome transitions on min/restore + fullscreen toggles.
      transition="border-radius 280ms ease, background-color 280ms ease"
      color={cyber ? 'term.ink2' : 'ink'}
      position={isFullscreen ? 'fixed' : 'relative'}
      // 4 px margin around every pane — the column/dock no longer owns
      // the gap. Suppressed in fullscreen + floating (those positions
      // already control their own offsets).
      m={isFullscreen || floating ? undefined : '4px'}
      flex={
        isFullscreen
          ? undefined
          : floating || bodyOverlay
            ? undefined
            : inlineCollapsed || isContentSized
              ? '0 0 auto'
              : '1 1 0'
      }
      // Floating panes + bodyOverlay (topbar tiles) size to their
      // header content. The host wrapper handles placement; the pane
      // just shrinks/grows around its header + body. Without
      // `fit-content`, bodyOverlay panes mounted in a row-flex
      // wrapper (the topbar) collapsed to 0 width because their old
      // `flex: 1 1 0` had nothing to fill against.
      w={floating || bodyOverlay ? 'fit-content' : undefined}
      minW={floating ? '88px' : undefined}
      minH={0}
      display="flex"
      flexDirection="column"
      overflow={overlayActive ? 'visible' : 'hidden'}
      style={isFullscreen ? FULLSCREEN_STYLE : undefined}
      _before={corners._before as never}
      _after={corners._after as never}
    >
      <FeatViewHeader
        id={feat}
        {...(status !== undefined ? { status } : {})}
        {...(statusBlink !== undefined ? { statusBlink } : {})}
        titleSlot={titleSlot}
        right={right}
        mode={mode}
        allowFullscreen={allowFullscreen}
        onMinimize={minimize}
        onRestore={restore}
        onFullscreen={goFullscreen}
        onExitFullscreen={exitFullscreen}
      />
      {overlayActive ? (
        <OverlayBody anchorRef={paneRef} cyber={cyber} onDismiss={minimize}>
          {children}
        </OverlayBody>
      ) : renderInlineBody ? (
        // Transparent body — the pane container already supplies the
        // glass surface. `max-height: 0` clamps the wrapper to 0 px
        // when minimized so the pane shrinks to header-only after
        // the FLIP lands; otherwise children intrinsic-sized to the
        // remaining flex space would keep the wrapper non-zero.
        // `overflow: hidden` clips during the FLIP transition.
        <Box
          flex={isMinimized || isContentSized ? '0 0 auto' : '1'}
          minH={0}
          maxH={isMinimized ? '0px' : undefined}
          bg="transparent"
          overflow="hidden"
        >
          <Box
            minH={0}
            overflowX="hidden"
            overflowY={isMinimized ? 'hidden' : 'auto'}
            display="flex"
            flexDirection="column"
            h="100%"
          >
            {children}
          </Box>
        </Box>
      ) : null}
    </Box>
  );

  if (!isFullscreen) {
    return paneBox;
  }

  // Fullscreen: keep a same-shaped placeholder in the column so
  // sibling panes don't jump up to fill the gap, then **portal** the
  // fullscreen pane to `document.body` so it escapes every ancestor
  // stacking / containing context. The Liquid Glass `backdrop-filter`
  // on TopBar would otherwise trap a fixed-positioned descendant
  // inside the topbar's bounding box (backdrop-filter creates a
  // containing block for fixed children per CSS spec) — visible
  // regression: USR.MAIN in topbar fullscreening into the topbar slot
  // instead of the viewport.
  //
  // Placeholder flex mirrors what the pane would have if it were not
  // fullscreen: `1 1 0` for normal panes, `0 0 auto` for content-sized
  // ones. Without this the column's leftover space gets reabsorbed by
  // the other panes and they slide around when fullscreen is entered.
  const placeholderFlex = isContentSized ? '0 0 auto' : '1 1 0';
  const portalTarget = typeof document === 'undefined' ? null : document.body;
  return (
    <>
      <Box
        ref={placeholderRef}
        flex={placeholderFlex}
        minH={0}
        visibility="hidden"
        // The exit animation reads the placeholder's bounding rect to
        // know where to fly the pane back to — that geometry is exactly
        // what the column reserved for this pane.
        aria-hidden="true"
      />
      {portalTarget === null ? paneBox : createPortal(paneBox, portalTarget)}
    </>
  );
}

function cornerStyle(corner: 'tl' | 'br', _cyber: boolean): Record<string, unknown> {
  void _cyber;
  // Single accent (朱砂) regardless of cyber mode — keeps the geek
  // angle markers as a consistent brand fingerprint instead of
  // splitting red/green between cyber and normal panes.
  const color = 'var(--chakra-colors-accent)';
  const base: Record<string, unknown> = {
    content: '""',
    position: 'absolute',
    width: '8px',
    height: '8px',
    opacity: 0.55,
    zIndex: 2,
    pointerEvents: 'none',
    borderColor: color,
  };
  if (corner === 'tl') {
    return { ...base, top: '-1px', left: '-1px', borderTopWidth: '1px', borderLeftWidth: '1px' };
  }
  return {
    ...base,
    bottom: '-1px',
    right: '-1px',
    borderBottomWidth: '1px',
    borderRightWidth: '1px',
  };
}

interface FeatViewHeaderProps {
  readonly id: string;
  readonly status?: FeatViewStatusTone;
  readonly statusBlink?: boolean;
  readonly titleSlot?: ReactNode;
  readonly right?: ReactNode;
  readonly mode: FeatViewMode;
  /** Floating panes hide the fullscreen button — they're already
   *  detached from the column grid, so growing edge-to-edge is a no-op. */
  readonly allowFullscreen: boolean;
  readonly onMinimize: () => void;
  readonly onRestore: () => void;
  readonly onFullscreen: () => void;
  readonly onExitFullscreen: () => void;
}

function FeatViewHeader(props: FeatViewHeaderProps): React.ReactElement {
  const {
    id,
    status,
    statusBlink,
    titleSlot,
    right,
    mode,
    onMinimize,
    onRestore,
    onFullscreen,
    onExitFullscreen,
    allowFullscreen,
  } = props;
  return (
    <Flex
      align="center"
      gap="8px"
      px="10px"
      h="28px"
      // Single header surface across every pane — cyber-skinned panes
      // (TERM / AI / SYS / SET / WATCH / SCR.NL etc.) used to swap to
      // `term.bgElev`, but that made adjacent panes look mismatched
      // depending on their `cyber` flag. The caller no longer
      // configures the header bg — uniformity wins.
      bg="glass.panelSoft"
      borderBottomWidth="1px"
      borderBottomColor="glass.line"
      flexShrink={0}
      color="ink3"
    >
      <FeatNameToggle
        id={id}
        minimized={mode === 'minimized'}
        onToggle={mode === 'minimized' ? onRestore : onMinimize}
        disabled={mode === 'fullscreen'}
      />
      {status !== undefined && (
        <Box flexShrink={0}>
          <FeatViewStatus tone={status} blink={statusBlink ?? false} />
        </Box>
      )}
      {titleSlot !== undefined && <Box flexShrink={0}>{titleSlot}</Box>}
      {right !== undefined && (
        <Flex
          align="center"
          gap="6px"
          fontFamily="mono"
          fontSize="xs"
          letterSpacing="0.06em"
          flexShrink={0}
        >
          {right}
        </Flex>
      )}
      <HStack
        ml="auto"
        gap="10px"
        fontFamily="mono"
        fontSize="xs"
        letterSpacing="0.06em"
        color="ink3"
        flexShrink={0}
      >
        <FeatViewControls
          mode={mode}
          allowFullscreen={allowFullscreen}
          onFullscreen={onFullscreen}
          onExitFullscreen={onExitFullscreen}
        />
      </HStack>
    </Flex>
  );
}

interface FeatViewControlsProps {
  readonly mode: FeatViewMode;
  readonly allowFullscreen: boolean;
  readonly onFullscreen: () => void;
  readonly onExitFullscreen: () => void;
}

/**
 * Pane window controls. After the 2026-05 chrome simplification the
 * minimize / restore button is gone — clicking the pane name in
 * `<FeatNameToggle>` toggles `minimized` ↔ `normal`. Only fullscreen
 * remains as an explicit button (no obvious header gesture for it).
 *
 * Floating panes (`allowFullscreen=false`) collapse to nothing here —
 * the toggle button + chevron in the name handle the only meaningful
 * state change.
 */
function FeatViewControls({
  mode,
  allowFullscreen,
  onFullscreen,
  onExitFullscreen,
}: FeatViewControlsProps): React.ReactElement | null {
  if (!allowFullscreen) return null;
  return (
    <HStack gap="2px">
      {mode === 'fullscreen' ? (
        <MonoButton icon="exitFullscreen" label="exit fullscreen" onClick={onExitFullscreen} />
      ) : (
        <MonoButton icon="fullscreen" label="fullscreen" onClick={onFullscreen} />
      )}
    </HStack>
  );
}

interface FeatNameToggleProps {
  readonly id: string;
  readonly minimized: boolean;
  readonly onToggle: () => void;
  /** Fullscreen panes can't be minimized — the toggle becomes a no-op label. */
  readonly disabled: boolean;
}

/**
 * Pane name button. Clicking it toggles `minimized` ↔ `normal` —
 * replaces the old minimize/restore icon buttons. The chevron marker
 * reflects current state (▾ open / ▸ collapsed) so the affordance
 * reads at a glance. Disabled when fullscreen.
 */
const TOGGLE_BTN_STYLE = {
  bg: 'transparent',
  border: '0',
  px: 0,
  py: 0,
  align: 'baseline',
  gap: '6px',
  flexShrink: 0,
  _focusVisible: { outline: '2px solid', outlineColor: 'link', outlineOffset: '2px' },
  style: { font: 'inherit' },
} as const;

function FeatNameToggle({
  id,
  minimized,
  onToggle,
  disabled,
}: FeatNameToggleProps): React.ReactElement {
  return (
    <Flex
      {...TOGGLE_BTN_STYLE}
      as="button"
      onClick={disabled ? undefined : onToggle}
      aria-pressed={minimized}
      aria-label={`${id} — ${minimized ? 'restore' : 'minimize'}`}
      aria-disabled={disabled}
      cursor={disabled ? 'default' : 'pointer'}
      _hover={disabled ? {} : { color: 'accent' }}
    >
      {/* Reserve space even when invisible so the name doesn't shift
          when entering/exiting fullscreen. */}
      <Box
        as="span"
        fontFamily="mono"
        fontSize="xs"
        color="ink3"
        opacity={disabled ? 0 : 0.7}
        w="8px"
        textAlign="center"
      >
        {minimized ? '▸' : '▾'}
      </Box>
      <Box
        as="span"
        fontFamily="mono"
        fontSize="xs"
        letterSpacing="0.18em"
        fontWeight="700"
        color="accent"
        whiteSpace="nowrap"
      >
        {id}
      </Box>
    </Flex>
  );
}

interface OverlayBodyProps {
  readonly anchorRef: React.RefObject<HTMLDivElement>;
  readonly cyber: boolean;
  readonly onDismiss: () => void;
  readonly children: ReactNode;
}

interface OverlayRect {
  readonly top: number;
  readonly left: number;
  readonly width: number;
}

/**
 * Floating dropdown anchored under the pane's outer rect. Used by panes
 * that live in narrow chrome (top-bar) where there is no inline space
 * for an expanded body. Closes on outside click or Esc.
 */
function OverlayBody({
  anchorRef,
  cyber,
  onDismiss,
  children,
}: OverlayBodyProps): React.ReactElement | null {
  const [rect, setRect] = useState<OverlayRect | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = anchorRef.current;
    if (node === null) return;
    const update = (): void => {
      const r = node.getBoundingClientRect();
      const margin = 8;
      // Prefer wider than the anchor so settings forms breathe; clamp
      // to viewport so a host that itself overflows (eg. a topbar
      // narrower than brand+pane) doesn't push the body off-screen.
      const target = Math.max(r.width, 480);
      const width = Math.min(target, window.innerWidth - margin * 2);
      const desiredLeft = r.right - width;
      const left = Math.min(Math.max(desiredLeft, margin), window.innerWidth - width - margin);
      setRect({ top: r.bottom, left, width });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(node);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [anchorRef]);

  useEffect(() => {
    const onDocDown = (e: MouseEvent): void => {
      const ov = overlayRef.current;
      const an = anchorRef.current;
      const t = e.target;
      if (!(t instanceof Node)) return;
      if (ov?.contains(t) === true) return;
      if (an?.contains(t) === true) return;
      onDismiss();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDismiss();
    };
    document.addEventListener('mousedown', onDocDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [anchorRef, onDismiss]);

  if (rect === null) return null;
  // **Critical**: render through a portal to `document.body`. The TopBar
  // applies `backdrop-filter` (for its glass effect), and per the CSS
  // spec that creates a new containing block for ALL fixed-positioned
  // descendants. Without the portal, this `position:fixed` would be
  // clipped/stacked relative to the TopBar (the OverlayBody is a child
  // of the topbar-mounted FeatView via anchorRef), and SYS / USR
  // dropdowns rendered behind the TopBar instead of below it. The
  // portal lifts the node to body, escaping that containment.
  const overlay = (
    <FloatingSurface
      ref={overlayRef}
      cyber={cyber}
      position="fixed"
      style={{
        top: `${String(rect.top)}px`,
        left: `${String(rect.left)}px`,
        width: `${String(rect.width)}px`,
        zIndex: 'var(--chakra-z-index-overlay, 1000)',
      }}
      maxH="60vh"
      overflow="auto"
    >
      {children}
    </FloatingSurface>
  );
  if (typeof document === 'undefined') return overlay;
  return createPortal(overlay, document.body);
}
