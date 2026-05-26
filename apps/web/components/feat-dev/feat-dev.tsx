'use client';

/**
 * DEV — perf telemetry strip, rendered inline in the FeatView header.
 *
 * The pane is a topbar tile (`bodyOverlay` + `noFullscreen` in the
 * feat-config map): all the live numbers (MEM / FPS / LCP / INP / CLS)
 * sit in the header's `right` slot so they stay visible without
 * expanding a body. Body is empty by design — the toggle just makes
 * the tile's chevron flip; there's nothing to reveal.
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
    <FeatView
      feat={Feat.Dev}
      right={
        <Flex
          direction="row"
          gap="10px"
          fontFamily="mono"
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
      }
    >
      {null}
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
