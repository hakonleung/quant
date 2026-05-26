'use client';

import { Box, Flex, HStack } from '@chakra-ui/react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal, flushSync } from 'react-dom';

import { FEAT_CONFIG_MAP, type Feat } from '../../lib/eqty/feat.js';
import { useLayoutStore, type FeatViewMode } from '../../lib/stores/layout.store.js';
import { MonoButton } from '../ui/mono-button.js';
import { FeatViewStatus, type FeatViewStatusTone } from './feat-view-header.js';

const TRANSITION_MS = 280;

/** Returns true when the user has asked for reduced motion. SSR-safe. */
const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Inline styles applied to the pane when it switches to fullscreen.
 * Lifted to module scope so the pane chrome stays under the per-
 * function line cap.
 *
 * **TopBar preserved.** We carve out the TopBar (`top: 52px desktop /
 * 44px mobile`) so users keep access to brand / SYS status / USR /
 * theme toggle / settings while a pane is fullscreen — the only UX
 * change versus fullscreen-edge-to-edge is that the very top 52px
 * stays in topbar mode, which is the Apple HIG pattern (full-window
 * apps still show the menu bar). Mobile uses 44px topbar height.
 *
 * z-index uses the unified `fullscreen` token (1500) — above
 * overlay/dialog/scrim but below toast/hint/tooltip so transient
 * messages can still surface.
 */
const FULLSCREEN_STYLE = {
  top: 'calc(var(--app-topbar-h, 52px) + env(safe-area-inset-top))',
  left: 0,
  width: '100vw',
  height: 'calc(100dvh - var(--app-topbar-h, 52px) - env(safe-area-inset-top))',
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
  /**
   * Tall, two-row header that matches the topbar logo height. Window
   * controls sit on the first row's right edge; `right` fills the rest
   * of the first row, `rightSecondary` (only meaningful with
   * `tallHeader`) fills the second row.
   */
  readonly tallHeader?: boolean;
  /** Second-row content for the tall header. Ignored when `tallHeader`
   *  is false. */
  readonly rightSecondary?: ReactNode;
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
  tallHeader,
  rightSecondary,
  children,
}: FeatViewProps): React.ReactElement {
  if (bare === true) return <>{children}</>;
  const config = FEAT_CONFIG_MAP[feat];
  const cyber = config.cyber ?? false;
  const bodyOverlay = config.bodyOverlay ?? false;

  // Persisted mode keyed by feat id — survives reloads. Missing entries
  // fall back to the static `defaultMinimized` flag in feat config.
  const persistedMode = useLayoutStore((s) => s.featViewMode[feat]);
  const setPersistedMode = useLayoutStore((s) => s.setFeatViewMode);
  const mode: FeatViewMode =
    persistedMode ?? (config.defaultMinimized === true ? 'minimized' : 'normal');
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
    // play a Web Animations keyframe from the starting rect → fullscreen.
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
          // 100dvh follows iOS dynamic viewport (URL bar / keyboard);
          // 100vh would let the bottom of the pane slip below the
          // address bar after a swipe-down.
          { top: '0px', left: '0px', width: '100vw', height: '100dvh' },
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
    const anim = node.animate(
      [
        { top: '0px', left: '0px', width: '100vw', height: '100dvh' },
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
      // pane briefly snaps back to 100vw/100dvh on cancel and flickers.
      flushSync(() => {
        setMode('normal');
      });
      anim.cancel();
    };
  }, []);

  const minimize = useCallback((): void => {
    setMode('minimized');
  }, []);

  const restore = useCallback((): void => {
    setMode('normal');
  }, []);

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

  // Body collapses by max-height transition; explicit ceiling keeps the
  // animation smooth even when content is taller than the viewport.
  const bodyMaxH = inlineCollapsed ? '0px' : '4000px';

  const paneBox = (
    <Box
      ref={paneRef}
      // Liquid Glass floating pane — backdrop-filter blurs body
      // wallpaper behind the pane. Dialogs are portaled to body to
      // escape the containing-block this creates.
      bg={isFullscreen ? 'panel' : cyber ? 'term.panel' : 'glass.panel'}
      backdropFilter={isFullscreen ? undefined : 'blur(16px) saturate(180%)'}
      borderWidth={isFullscreen ? 0 : '1px'}
      borderColor={cyber ? 'term.line' : 'glass.line'}
      borderRadius={isFullscreen ? 'none' : 'xs'}
      boxShadow={isFullscreen ? 'none' : 'glass'}
      // Smooth transitions for the mode toggles (normal ↔ minimized
      // ↔ fullscreen) so the pane chrome morphs instead of snapping.
      transition="border-radius 280ms ease, box-shadow 280ms ease, background-color 280ms ease"
      color={cyber ? 'term.ink2' : 'ink'}
      position={isFullscreen ? 'fixed' : 'relative'}
      flex={
        isFullscreen
          ? undefined
          : bodyOverlay
            ? '1 1 0'
            : inlineCollapsed || contentSized === true
              ? '0 0 auto'
              : '1 1 0'
      }
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
        rightSecondary={rightSecondary}
        cyber={cyber}
        mode={mode}
        tall={tallHeader ?? false}
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
        <Box
          flex={isMinimized || contentSized === true ? '0 0 auto' : '1'}
          minH={0}
          overflowX="hidden"
          overflowY={isMinimized ? 'hidden' : 'auto'}
          display="flex"
          flexDirection="column"
          style={{
            maxHeight: bodyMaxH,
            opacity: isMinimized ? 0 : 1,
            transition: `max-height ${TRANSITION_MS}ms ease, opacity ${TRANSITION_MS}ms ease`,
          }}
        >
          {children}
        </Box>
      ) : null}
    </Box>
  );

  if (!isFullscreen) {
    return paneBox;
  }

  // Fullscreen: keep a same-sized placeholder in the grid so layout
  // doesn't reflow underneath, then **portal** the fullscreen pane to
  // `document.body` so it escapes every ancestor stacking / containing
  // context. The Liquid Glass `backdrop-filter` on TopBar would
  // otherwise trap a fixed-positioned descendant inside the topbar's
  // bounding box (backdrop-filter creates a containing block for fixed
  // children per CSS spec) — visible regression: USR.MAIN in topbar
  // fullscreening into the topbar slot instead of the viewport.
  const portalTarget = typeof document === 'undefined' ? null : document.body;
  return (
    <>
      {/* Same-sized placeholder keeps the column from collapsing while
          the real pane is portaled out to body for fullscreen. */}
      <Box ref={placeholderRef} h="100%" minH={0} visibility="hidden" />
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
  readonly rightSecondary?: ReactNode;
  readonly cyber: boolean;
  readonly mode: FeatViewMode;
  readonly tall: boolean;
  readonly onMinimize: () => void;
  readonly onRestore: () => void;
  readonly onFullscreen: () => void;
  readonly onExitFullscreen: () => void;
}

function FeatViewHeader(props: FeatViewHeaderProps): React.ReactElement {
  if (props.tall) return <FeatViewHeaderTall {...props} />;
  const {
    id,
    status,
    statusBlink,
    titleSlot,
    right,
    cyber,
    mode,
    onMinimize,
    onRestore,
    onFullscreen,
    onExitFullscreen,
  } = props;
  return (
    <Flex
      align="center"
      gap="8px"
      px="10px"
      h={cyber ? '30px' : '28px'}
      // Header is transparent so the parent pane's glass + ambient
      // mesh reads through unbroken. Only a hairline divider stays.
      bg="transparent"
      borderBottomWidth="1px"
      borderBottomColor={cyber ? 'term.line' : 'glass.line'}
      flexShrink={0}
      color={cyber ? 'term.ink3' : 'ink3'}
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
        color={cyber ? 'term.ink3' : 'ink3'}
        flexShrink={0}
      >
        <FeatViewControls
          mode={mode}
          onFullscreen={onFullscreen}
          onExitFullscreen={onExitFullscreen}
        />
      </HStack>
    </Flex>
  );
}

/**
 * Two-row header used by SYS / USR — height matches the topbar logo
 * (52px desktop / 44px mobile).
 *
 * Row 1: id + status + titleSlot + `right` (primary content)
 *        + window controls (always pinned to the right).
 * Row 2: `rightSecondary` content (web vitals on SYS, tabs on USR).
 */
function FeatViewHeaderTall({
  id,
  status,
  statusBlink,
  titleSlot,
  right,
  rightSecondary,
  cyber,
  mode,
  onMinimize,
  onRestore,
  onFullscreen,
  onExitFullscreen,
}: FeatViewHeaderProps): React.ReactElement {
  return (
    <Flex
      direction="column"
      px="10px"
      py="2px"
      h={{ base: '44px', md: '52px' }}
      // Tall header is transparent — sits inside the TopBar's own
      // glass surface, so its only chrome is a hairline divider.
      bg="transparent"
      borderBottomWidth="1px"
      borderBottomColor={cyber ? 'term.line' : 'glass.line'}
      flexShrink={0}
      color={cyber ? 'term.ink3' : 'ink3'}
      justify="space-between"
    >
      <Flex align="center" gap="8px" flexShrink={0} minW={0}>
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
            flex="1"
            minW={0}
            overflow="hidden"
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
          color={cyber ? 'term.ink3' : 'ink3'}
          flexShrink={0}
        >
          <FeatViewControls
            mode={mode}
            onFullscreen={onFullscreen}
            onExitFullscreen={onExitFullscreen}
          />
        </HStack>
      </Flex>
      <Flex
        align="center"
        gap="6px"
        fontFamily="mono"
        fontSize="xs"
        letterSpacing="0.06em"
        flexShrink={0}
        minW={0}
        overflow="hidden"
      >
        {rightSecondary}
      </Flex>
    </Flex>
  );
}

interface FeatViewControlsProps {
  readonly mode: FeatViewMode;
  readonly onFullscreen: () => void;
  readonly onExitFullscreen: () => void;
}

/**
 * Pane window controls. After the 2026-05 chrome simplification the
 * minimize / restore button is gone — clicking the pane name in
 * `<FeatNameToggle>` toggles `minimized` ↔ `normal`. Only fullscreen
 * remains as an explicit button (no obvious header gesture for it).
 */
function FeatViewControls({
  mode,
  onFullscreen,
  onExitFullscreen,
}: FeatViewControlsProps): React.ReactElement {
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
    <Box
      ref={overlayRef}
      position="fixed"
      style={{
        top: `${String(rect.top)}px`,
        left: `${String(rect.left)}px`,
        width: `${String(rect.width)}px`,
        zIndex: 'var(--chakra-z-index-overlay, 1000)',
      }}
      maxH="60vh"
      overflow="auto"
      // Floating popover — Liquid Glass surface. Cyber mode reuses
      // the term glass palette (frosted dark with the slight green
      // edge); normal mode uses the standard light/dark glass.
      bg={cyber ? 'term.panel' : 'glass.panel'}
      backdropFilter="blur(20px) saturate(180%)"
      color={cyber ? 'term.ink2' : 'ink'}
      borderWidth="1px"
      borderColor={cyber ? 'term.line' : 'glass.line'}
      borderRadius="xs"
      boxShadow="glass"
    >
      {children}
    </Box>
  );
  if (typeof document === 'undefined') return overlay;
  return createPortal(overlay, document.body);
}
