'use client';

import { Box, Flex, HStack, Text } from '@chakra-ui/react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';

import { FEAT_CONFIG_MAP, type Feat } from '../../lib/eqty/feat.js';
import { useLayoutStore, type FeatViewMode } from '../../lib/stores/layout.store.js';
import { MonoButton } from '../ui/mono-button.js';
import { FeatViewStatus, type FeatViewStatusTone } from './feat-view-header.js';

const TRANSITION_MS = 280;

interface FeatViewProps {
  readonly feat: Feat;
  /** Status pellet rendered between the id and the title slot — only
   *  paints for non-normal tones (see :class:`FeatViewStatus`). */
  readonly status?: FeatViewStatusTone;
  readonly statusBlink?: boolean;
  /** Custom title slot — when present takes the whole title position. */
  readonly titleSlot?: ReactNode;
  readonly right?: ReactNode;
  readonly children: ReactNode;
}

export function FeatView({
  feat,
  status,
  statusBlink,
  titleSlot,
  right,
  children,
}: FeatViewProps): React.ReactElement {
  const config = FEAT_CONFIG_MAP[feat];
  const cyber = config.cyber ?? false;
  const gridArea = config.gridArea;
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
          { top: '0px', left: '0px', width: '100vw', height: '100vh' },
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
    const r = ph.getBoundingClientRect();
    const anim = node.animate(
      [
        { top: '0px', left: '0px', width: '100vw', height: '100vh' },
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
      // pane briefly snaps back to 100vw/100vh on cancel and flickers.
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
      bg={cyber ? 'term.panel' : 'panel'}
      color={cyber ? 'term.ink2' : 'ink'}
      position={isFullscreen ? 'fixed' : 'relative'}
      flex={
        isFullscreen ? undefined : bodyOverlay ? '1 1 0' : inlineCollapsed ? '0 0 auto' : '1 1 0'
      }
      minH={0}
      display="flex"
      flexDirection="column"
      overflow={overlayActive ? 'visible' : 'hidden'}
      style={
        isFullscreen
          ? { top: 0, left: 0, width: '100vw', height: '100vh', zIndex: 1000 }
          : undefined
      }
      _before={corners._before as never}
      _after={corners._after as never}
    >
      <FeatViewHeader
        id={feat}
        {...(status !== undefined ? { status } : {})}
        {...(statusBlink !== undefined ? { statusBlink } : {})}
        titleSlot={titleSlot}
        right={right}
        cyber={cyber}
        mode={mode}
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
          flex={isMinimized ? '0 0 auto' : '1'}
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
  // doesn't reflow underneath, then portal-style render the pane via
  // position:fixed on top.
  return (
    <>
      <Box ref={placeholderRef} gridArea={gridArea} h="100%" minH={0} visibility="hidden" />
      {paneBox}
    </>
  );
}

function cornerStyle(corner: 'tl' | 'br', cyber: boolean): Record<string, unknown> {
  const color = cyber ? 'var(--chakra-colors-term-green)' : 'var(--chakra-colors-accent)';
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
  readonly cyber: boolean;
  readonly mode: FeatViewMode;
  readonly onMinimize: () => void;
  readonly onRestore: () => void;
  readonly onFullscreen: () => void;
  readonly onExitFullscreen: () => void;
}

function FeatViewHeader({
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
}: FeatViewHeaderProps): React.ReactElement {
  return (
    <Flex
      align="center"
      gap="8px"
      px="10px"
      h={cyber ? '30px' : '28px'}
      bg={cyber ? 'term.panel' : 'panel'}
      borderBottomWidth="1px"
      borderBottomColor={cyber ? 'term.line' : 'line'}
      flexShrink={0}
      color={cyber ? 'term.ink3' : 'ink3'}
    >
      <Text
        fontFamily="mono"
        fontSize="10px"
        letterSpacing="0.18em"
        fontWeight="700"
        color={cyber ? 'term.green' : 'accent'}
        whiteSpace="nowrap"
        flexShrink={0}
      >
        {id}
      </Text>
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
          fontSize="10px"
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
        fontSize="10px"
        letterSpacing="0.06em"
        color={cyber ? 'term.ink3' : 'ink3'}
        flexShrink={0}
      >
        <FeatViewControls
          cyber={cyber}
          mode={mode}
          onMinimize={onMinimize}
          onRestore={onRestore}
          onFullscreen={onFullscreen}
          onExitFullscreen={onExitFullscreen}
        />
      </HStack>
    </Flex>
  );
}

interface FeatViewControlsProps {
  readonly cyber: boolean;
  readonly mode: FeatViewMode;
  readonly onMinimize: () => void;
  readonly onRestore: () => void;
  readonly onFullscreen: () => void;
  readonly onExitFullscreen: () => void;
}

function FeatViewControls({
  cyber: _cyber,
  mode,
  onMinimize,
  onRestore,
  onFullscreen,
  onExitFullscreen,
}: FeatViewControlsProps): React.ReactElement {
  void _cyber;
  return (
    <HStack gap="2px">
      {mode === 'fullscreen' ? (
        <MonoButton icon="exitFullscreen" label="exit fullscreen" onClick={onExitFullscreen} />
      ) : (
        <>
          <MonoButton icon="fullscreen" label="fullscreen" onClick={onFullscreen} />
          {mode === 'minimized' ? (
            <MonoButton icon="restore" label="restore" onClick={onRestore} />
          ) : (
            <MonoButton icon="minimize" label="minimize" onClick={onMinimize} />
          )}
        </>
      )}
    </HStack>
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
  return (
    <Box
      ref={overlayRef}
      position="fixed"
      style={{
        top: `${String(rect.top)}px`,
        left: `${String(rect.left)}px`,
        width: `${String(rect.width)}px`,
        zIndex: 1100,
      }}
      maxH="60vh"
      overflow="auto"
      bg={cyber ? 'term.panel' : 'panel'}
      color={cyber ? 'term.ink2' : 'ink'}
      borderWidth="1px"
      borderColor={cyber ? 'term.line' : 'line'}
      boxShadow="0 14px 48px rgba(0,0,0,0.55)"
    >
      {children}
    </Box>
  );
}
