'use client';

import { Box, Flex, HStack, Text } from '@chakra-ui/react';
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { flushSync } from 'react-dom';

import { FEAT_CONFIG_MAP, type Feat } from '../../lib/eqty/feat.js';
import { useLayoutStore, type PaneMode } from '../../lib/stores/layout.store.js';

const TRANSITION_MS = 280;

interface PaneProps {
  readonly feat: Feat;
  /** Optional override; defaults to {@link FEAT_CONFIG_MAP}.title(). */
  readonly title?: string;
  readonly right?: ReactNode;
  readonly children: ReactNode;
}

export function Pane({ feat, title, right, children }: PaneProps): React.ReactElement {
  const config = FEAT_CONFIG_MAP[feat];
  const resolvedTitle = title ?? config.title();
  const cyber = config.cyber ?? false;
  const gridArea = config.gridArea;

  // Persisted mode keyed by feat id — survives reloads. Missing entries
  // fall back to the static `defaultMinimized` flag in feat config.
  const persistedMode = useLayoutStore((s) => s.paneMode[feat]);
  const setPersistedMode = useLayoutStore((s) => s.setPaneMode);
  const mode: PaneMode =
    persistedMode ?? (config.defaultMinimized === true ? 'minimized' : 'normal');
  const setMode = useCallback(
    (m: PaneMode): void => {
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

  // Body collapses by max-height transition; explicit ceiling keeps the
  // animation smooth even when content is taller than the viewport.
  const bodyMaxH = isMinimized ? '0px' : '4000px';

  const paneBox = (
    <Box
      ref={paneRef}
      bg={cyber ? 'term.panel' : 'panel'}
      color={cyber ? 'term.ink2' : 'ink'}
      position={isFullscreen ? 'fixed' : 'relative'}
      flex={isFullscreen ? undefined : isMinimized ? '0 0 auto' : '1 1 0'}
      minH={0}
      display="flex"
      flexDirection="column"
      overflow="hidden"
      style={
        isFullscreen
          ? { top: 0, left: 0, width: '100vw', height: '100vh', zIndex: 1000 }
          : undefined
      }
      _before={corners._before as never}
      _after={corners._after as never}
    >
      <PaneHeader
        id={feat}
        title={resolvedTitle}
        right={right}
        cyber={cyber}
        mode={mode}
        onMinimize={minimize}
        onRestore={restore}
        onFullscreen={goFullscreen}
        onExitFullscreen={exitFullscreen}
      />
      <Box
        flex={isMinimized ? '0 0 auto' : '1'}
        minH={0}
        overflow="hidden"
        style={{
          maxHeight: bodyMaxH,
          opacity: isMinimized ? 0 : 1,
          transition: `max-height ${TRANSITION_MS}ms ease, opacity ${TRANSITION_MS}ms ease`,
        }}
      >
        {children}
      </Box>
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
  return { ...base, bottom: '-1px', right: '-1px', borderBottomWidth: '1px', borderRightWidth: '1px' };
}

interface HeaderProps {
  readonly id: string;
  readonly title: string;
  readonly right?: ReactNode;
  readonly cyber: boolean;
  readonly mode: PaneMode;
  readonly onMinimize: () => void;
  readonly onRestore: () => void;
  readonly onFullscreen: () => void;
  readonly onExitFullscreen: () => void;
}

function PaneHeader({
  id,
  title,
  right,
  cyber,
  mode,
  onMinimize,
  onRestore,
  onFullscreen,
  onExitFullscreen,
}: HeaderProps): React.ReactElement {
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
    >
      <Text
        fontFamily="mono"
        fontSize="10px"
        letterSpacing="0.18em"
        fontWeight="700"
        color={cyber ? 'term.green' : 'accent'}
        whiteSpace="nowrap"
        flexShrink={0}
        pr="8px"
        borderRightWidth="1px"
        borderColor={cyber ? 'term.line' : 'line'}
      >
        {id}
      </Text>
      <Text
        fontFamily="mono"
        fontSize="10px"
        letterSpacing="0.18em"
        textTransform="uppercase"
        fontWeight="600"
        color={cyber ? 'term.ink2' : 'ink2'}
        whiteSpace="nowrap"
        overflow="hidden"
        textOverflow="ellipsis"
        flexShrink={0}
        pr="8px"
        borderRightWidth={right !== undefined ? '1px' : 0}
        borderColor={cyber ? 'term.line' : 'line'}
      >
        {title}
      </Text>
      {right !== undefined && (
        <Box
          fontFamily="mono"
          fontSize="10px"
          letterSpacing="0.06em"
          color={cyber ? 'term.ink3' : 'ink3'}
          flex="1"
          minW={0}
          overflow="hidden"
          textOverflow="ellipsis"
          whiteSpace="nowrap"
        >
          {right}
        </Box>
      )}
      <HStack
        ml="auto"
        gap="10px"
        fontFamily="mono"
        fontSize="10px"
        letterSpacing="0.06em"
        color={cyber ? 'term.ink3' : 'ink3'}
        flexShrink={0}
        pl="8px"
        borderLeftWidth="1px"
        borderColor={cyber ? 'term.line' : 'line'}
      >
        <PaneControls
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

interface ControlsProps {
  readonly cyber: boolean;
  readonly mode: PaneMode;
  readonly onMinimize: () => void;
  readonly onRestore: () => void;
  readonly onFullscreen: () => void;
  readonly onExitFullscreen: () => void;
}

function PaneControls({
  cyber,
  mode,
  onMinimize,
  onRestore,
  onFullscreen,
  onExitFullscreen,
}: ControlsProps): React.ReactElement {
  return (
    <HStack gap="2px">
      {mode === 'minimized' ? (
        <CtlButton cyber={cyber} label="restore" onClick={onRestore}>
          ▢
        </CtlButton>
      ) : mode === 'fullscreen' ? (
        <CtlButton cyber={cyber} label="exit fullscreen" onClick={onExitFullscreen}>
          ◱
        </CtlButton>
      ) : (
        <>
          <CtlButton cyber={cyber} label="minimize" onClick={onMinimize}>
            —
          </CtlButton>
          <CtlButton cyber={cyber} label="fullscreen" onClick={onFullscreen}>
            ⛶
          </CtlButton>
        </>
      )}
    </HStack>
  );
}

interface CtlButtonProps {
  readonly cyber: boolean;
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}

function CtlButton({ cyber, label, onClick, children }: CtlButtonProps): React.ReactElement {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      style={{
        width: '18px',
        height: '18px',
        display: 'grid',
        placeItems: 'center',
        fontFamily: 'var(--font-mono, monospace)',
        fontSize: '11px',
        lineHeight: 1,
        color: 'inherit',
        background: 'transparent',
        border: '1px solid transparent',
        cursor: 'pointer',
      }}
      data-cyber={cyber ? 'true' : 'false'}
    >
      {children}
    </button>
  );
}
