'use client';

/**
 * Bottom tips bar — replaces the previous mixed BottomBar (sys metrics +
 * F-keys) and the in-xterm DECSTBM status row. Now the footer carries
 * only the contextual key hints from the active terminal widget /
 * idle-prompt cheat sheet.
 *
 * Hints are derived from the terminal state:
 *   - phase === 'interactive' → call `state.active.widget.hints(state)`
 *   - phase === 'running'      → "Ctrl+C cancel"
 *   - phase === 'cancelling'   → "Ctrl+C force cancel"
 *   - phase === 'idle'         → static cheat-sheet (Tab / ↑↓ / Ctrl+L / help)
 */

import { Flex, Text } from '@chakra-ui/react';
import type { KeyHint, TerminalState } from '@quant/terminal';

const IDLE_HINTS: readonly KeyHint[] = [
  { keys: ['Tab'], label: 'complete' },
  { keys: ['↑', '↓'], label: 'history' },
  { keys: ['Ctrl+L'], label: 'clear' },
  { keys: ['help'], label: 'commands' },
];

interface Props {
  readonly state: TerminalState;
}

export function TipsBar({ state }: Props): React.ReactElement {
  const hints = collectHints(state);

  return (
    <Flex
      px="18px"
      py="6px"
      borderTopWidth="1px"
      borderTopColor="term.line"
      bg="brand.panelAlpha"
      align="center"
      gap="14px"
      fontFamily="mono"
      fontSize="11px"
      letterSpacing="0.14em"
      color="term.ink2"
      flexShrink={0}
      minH="28px"
      flexWrap="wrap"
    >
      <PhaseIndicator state={state} />
      {hints.map((h, i) => (
        <HintItem key={`${i}-${h.label}`} hint={h} />
      ))}
    </Flex>
  );
}

function PhaseIndicator({ state }: { state: TerminalState }): React.ReactElement {
  const { phase } = state;
  const dotColor =
    phase === 'idle'
      ? 'term.green'
      : phase === 'running'
        ? 'link'
        : phase === 'cancelling'
          ? 'accent'
          : 'link';
  const label =
    phase === 'idle'
      ? 'READY'
      : phase === 'running'
        ? 'RUNNING'
        : phase === 'cancelling'
          ? 'CANCEL…'
          : 'INPUT';
  return (
    <Flex align="center" gap="6px">
      <Text color={dotColor}>●</Text>
      <Text color={dotColor} fontWeight="700">
        {label}
      </Text>
    </Flex>
  );
}

function HintItem({ hint }: { hint: KeyHint }): React.ReactElement {
  const danger = hint.danger === true;
  const keyColor = danger ? 'up' : 'link';
  const labelColor = danger ? 'up' : 'term.ink2';
  return (
    <Flex align="baseline" gap="6px">
      <Text color={keyColor} fontWeight="700">
        {hint.keys.join('/')}
      </Text>
      <Text color={labelColor}>{hint.label}</Text>
    </Flex>
  );
}

function collectHints(state: TerminalState): readonly KeyHint[] {
  if (state.phase === 'interactive' && state.active !== null) {
    return state.active.widget.hints(state.active.state);
  }
  if (state.phase === 'cancelling') {
    return [{ keys: ['Ctrl+C'], label: 'force cancel', danger: true }];
  }
  if (state.phase === 'running') {
    return [{ keys: ['Ctrl+C'], label: 'cancel', danger: true }];
  }
  return IDLE_HINTS;
}
