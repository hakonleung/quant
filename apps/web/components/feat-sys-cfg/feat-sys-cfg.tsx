'use client';

/**
 * Config pane (SYS.CFG, cyber skin).
 *
 * Two-column layout:
 *   - left: section nav (clickable, single-select)
 *   - right: section content; horizontally scrollable when the chosen
 *     surface is wider than the dropdown.
 *
 * The pane never overflows its host: the outer Box clips, the right
 * column owns vertical+horizontal scroll. All edits are persisted
 * inline via the underlying stores (no save/cancel).
 *
 * Note: the user-maintained "blacklist" section was removed in 2026-05;
 * the A-share noise blacklist is now backend-cron-managed and surfaced
 * via `useBlacklistQuery` (consumed by `feat-sec-list` to filter the
 * synthetic "all" sector).
 */

import { Box, Flex } from '@chakra-ui/react';
import { useState } from 'react';

import { Feat } from '../../lib/eqty/feat.js';
import { ColumnManager } from '../feat-eq-list/column-manager.js';
import { FeatView } from '../feat-view/feat-view.js';

type Section = 'columns';

const SECTIONS: ReadonlyArray<{
  readonly id: Section;
  readonly label: string;
}> = [{ id: 'columns', label: 'columns' }];

export function FeatSysCfg(): React.ReactElement {
  const [section, setSection] = useState<Section>('columns');

  return (
    <FeatView feat={Feat.SysCfg}>
      <Flex
        h="420px"
        maxH="60vh"
        bg="term.panel"
        color="term.ink2"
        fontFamily="mono"
        fontSize="11px"
        overflow="hidden"
      >
        <SectionNav active={section} onSelect={setSection} />
        <Box flex="1" minW={0} h="100%" overflow="auto">
          {section === 'columns' && <ColumnManager />}
        </Box>
      </Flex>
    </FeatView>
  );
}

interface SectionNavProps {
  readonly active: Section;
  readonly onSelect: (s: Section) => void;
}

function SectionNav({ active, onSelect }: SectionNavProps): React.ReactElement {
  return (
    <Box flex="0 0 120px" h="100%" borderRightWidth="1px" borderColor="term.line" overflow="auto">
      {SECTIONS.map((s) => {
        const selected = s.id === active;
        return (
          <Box
            as="button"
            key={s.id}
            onClick={(): void => {
              onSelect(s.id);
            }}
            display="block"
            w="100%"
            textAlign="left"
            px="12px"
            py="8px"
            fontFamily="mono"
            fontSize="11px"
            letterSpacing="0.16em"
            textTransform="uppercase"
            color={selected ? 'term.green' : 'term.ink2'}
            bg={selected ? 'term.bgElev' : 'transparent'}
            borderLeftWidth="2px"
            borderLeftColor={selected ? 'term.green' : 'transparent'}
            cursor="pointer"
            _hover={{ color: 'term.green' }}
          >
            {s.label}
          </Box>
        );
      })}
    </Box>
  );
}
