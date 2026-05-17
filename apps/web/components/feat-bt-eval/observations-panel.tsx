'use client';

/**
 * Inline expansion under a summary row — shows up to 200 observations
 * at a single holding. Kept tiny on purpose: the box plot + summary
 * row already carry the aggregate story, this panel is for spot-
 * checking individual (date, code) → return tuples.
 */

import { Box, Text } from '@chakra-ui/react';
import type { BacktestObservation } from '@quant/shared';

import { Cell } from './cell.js';

const MAX_ROWS = 200;
const HEADERS = ['date', 'code', 'entry', 'exit', 'ret', 'excess'] as const;

interface ObservationsPanelProps {
  readonly observations: readonly BacktestObservation[];
  readonly holding: number;
}

export function ObservationsPanel({
  observations,
  holding,
}: ObservationsPanelProps): React.ReactElement {
  if (observations.length === 0) {
    return (
      <Text fontFamily="mono" fontSize="10px" color="ink3" letterSpacing="0.06em">
        // no observations at holding={String(holding)}d
      </Text>
    );
  }
  const top = observations.slice(0, MAX_ROWS);
  return (
    <Box maxH="220px" overflowY="auto" borderTopWidth="1px" borderColor="line" pt="4px">
      <Box
        as="table"
        width="100%"
        fontFamily="mono"
        fontSize="10px"
        style={{ borderCollapse: 'collapse' }}
      >
        <HeaderRow />
        <Box as="tbody">
          {top.map((o) => (
            <ObservationRow key={`${o.signalDate}-${o.code}`} obs={o} />
          ))}
        </Box>
      </Box>
      {observations.length > MAX_ROWS && (
        <Text fontFamily="mono" fontSize="9px" color="ink3" mt="2px">
          // showing first {String(MAX_ROWS)} of {String(observations.length)}
        </Text>
      )}
    </Box>
  );
}

function HeaderRow(): React.ReactElement {
  return (
    <Box as="thead">
      <Box as="tr" color="ink3">
        {HEADERS.map((h) => (
          <Box
            as="td"
            key={h}
            px="4px"
            py="2px"
            textAlign={h === 'date' || h === 'code' ? 'left' : 'right'}
            borderBottomWidth="1px"
            borderColor="line"
          >
            {h}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function ObservationRow({ obs }: { readonly obs: BacktestObservation }): React.ReactElement {
  return (
    <Box as="tr" color="ink">
      <Box as="td" px="4px" py="2px">
        {obs.signalDate}
      </Box>
      <Box as="td" px="4px" py="2px">
        {obs.code}
      </Box>
      <Cell num={obs.entryPx} digits={2} />
      <Cell num={obs.exitPx} digits={2} />
      <Cell num={obs.ret} pct />
      {obs.excessRet === null ? <Cell num={NaN} /> : <Cell num={obs.excessRet} pct />}
    </Box>
  );
}
