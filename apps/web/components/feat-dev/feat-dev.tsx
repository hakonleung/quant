'use client';

/**
 * DEV — floating overlay surface for perf telemetry.
 *
 * Was a pile of capsules at the right end of the SYS header. Moved
 * out in 2026-05 so the topbar stays readable and the metrics surface
 * stays opt-in: the pane defaults to minimized; clicking `DEV` toggles
 * the body, which renders MEM / FPS / LCP / INP / CLS in an 8 px mono
 * strip — small enough to leave open in the corner without stealing
 * eye time.
 *
 * The pane is `floating`: the consumer wraps it in a fixed-position
 * dock (see `<AppShell>`'s floating dock); FeatView itself just sizes
 * the pane to its content and skips the fullscreen control.
 */

import { Flex, Text } from '@chakra-ui/react';

import { Feat } from '../../lib/eqty/feat.js';
import { formatMemMb, fpsColor, memColor } from '../../lib/fp/sys-stat-fmt.js';
import { fmtCls, fmtMs, vitalColor, vitalTitle } from '../../lib/fp/web-vitals-fmt.js';
import { useWebVitals, type VitalSample } from '../../lib/hooks/use-web-vitals.js';
import { useFps, useMemoryMb } from '../feat-sys-stat/use-sys-stat.js';
import { FeatView } from '../feat-view/feat-view.js';

export function FeatDev(): React.ReactElement {
  const fps = useFps();
  const memMb = useMemoryMb();
  const vitals = useWebVitals();
  return (
    <FeatView feat={Feat.Dev}>
      <Flex
        direction="row"
        gap="10px"
        px="8px"
        py="4px"
        fontFamily="mono"
        // 8 px keeps the whole strip ≤ ~220 px wide so the dock stays
        // out of the way of the user's actual work.
        fontSize="8px"
        letterSpacing="0.10em"
        whiteSpace="nowrap"
        color="term.ink3"
      >
        <Stat label="MEM" value={formatMemMb(memMb)} valueColor={memColor(memMb)} />
        <Stat label="FPS" value={String(fps)} valueColor={fpsColor(fps)} />
        <VitalStat label="LCP" sample={vitals.lcp} fmt={fmtMs} />
        <VitalStat label="INP" sample={vitals.inp} fmt={fmtMs} />
        <VitalStat label="CLS" sample={vitals.cls} fmt={fmtCls} />
      </Flex>
    </FeatView>
  );
}

interface StatProps {
  readonly label: string;
  readonly value: string;
  readonly valueColor: string;
}

function Stat({ label, value, valueColor }: StatProps): React.ReactElement {
  return (
    <Flex gap="3px" align="baseline">
      <Text as="span" color="term.green" fontWeight="700">
        {label}
      </Text>
      <Text as="span" color={valueColor} fontWeight="700">
        {value}
      </Text>
    </Flex>
  );
}

interface VitalStatProps {
  readonly label: 'LCP' | 'INP' | 'CLS';
  readonly sample: VitalSample | null;
  readonly fmt: (s: VitalSample | null) => string;
}

function VitalStat({ label, sample, fmt }: VitalStatProps): React.ReactElement {
  return (
    <Flex gap="3px" align="baseline" title={vitalTitle(label, sample)}>
      <Text as="span" color="term.green" fontWeight="700">
        {label}
      </Text>
      <Text as="span" color={vitalColor(sample)} fontWeight="700">
        {fmt(sample)}
      </Text>
    </Flex>
  );
}
