'use client';

/**
 * Config pane (SYS.CFG, cyber skin).
 *
 * Two-column layout:
 *   - left: section nav (clickable, single-select)
 *   - right: section content; horizontally scrollable when the chosen
 *     surface is wider than the dropdown (e.g. the columns manager has
 *     two 220px sub-columns).
 *
 * The pane never overflows its host: the outer Box clips, the right
 * column owns vertical+horizontal scroll. All edits are persisted
 * inline via the underlying stores (no save/cancel).
 */

import { Box, Flex, Text } from '@chakra-ui/react';
import { useState } from 'react';

import { Feat } from '../../lib/eqty/feat.js';
import { useBlacklistStore } from '../../lib/stores/blacklist.store.js';
import { ColumnManager } from '../eqty/column-manager.js';
import { Pane } from './pane.js';

type Section = 'columns' | 'blacklist';

const SECTIONS: ReadonlyArray<{
  readonly id: Section;
  readonly label: string;
}> = [
  { id: 'columns', label: 'columns' },
  { id: 'blacklist', label: 'blacklist' },
];

export function SysConfigPane(): React.ReactElement {
  const [section, setSection] = useState<Section>('columns');

  return (
    <Pane feat={Feat.SysCfg}>
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
          {section === 'blacklist' && <BlacklistView />}
        </Box>
      </Flex>
    </Pane>
  );
}

interface SectionNavProps {
  readonly active: Section;
  readonly onSelect: (s: Section) => void;
}

function SectionNav({ active, onSelect }: SectionNavProps): React.ReactElement {
  return (
    <Box
      flex="0 0 120px"
      h="100%"
      borderRightWidth="1px"
      borderColor="term.line"
      overflow="auto"
    >
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

function BlacklistView(): React.ReactElement {
  const blacklist = useBlacklistStore((s) => s.entries);
  const removeEntry = useBlacklistStore((s) => s.remove);
  if (blacklist.length === 0) {
    return (
      <Text
        px="12px"
        py="12px"
        fontFamily="mono"
        fontSize="11px"
        color="term.ink3"
        letterSpacing="0.12em"
      >
        // no blacklisted stocks
      </Text>
    );
  }
  return (
    <Box>
      {blacklist.map((b) => (
        <Flex
          key={b.code}
          align="center"
          gap="8px"
          px="12px"
          py="6px"
          borderBottomWidth="1px"
          borderColor="term.line"
          _hover={{ bg: 'term.bgElev' }}
        >
          <Box flex="1" minW={0}>
            <Text
              fontFamily="mono"
              fontSize="11px"
              color="term.ink"
              fontWeight="500"
              whiteSpace="nowrap"
            >
              {b.code} {b.name}
            </Text>
            <Text
              fontFamily="mono"
              fontSize="9px"
              color="term.ink3"
              letterSpacing="0.14em"
              mt="1px"
              whiteSpace="nowrap"
            >
              added {b.addedAt}
            </Text>
          </Box>
          <Box
            as="button"
            aria-label={`unblacklist ${b.code}`}
            title="remove from blacklist"
            onClick={(): void => {
              removeEntry(b.code);
            }}
            color="term.ink3"
            bg="transparent"
            borderWidth="1px"
            borderColor="term.line"
            px="6px"
            h="20px"
            lineHeight="18px"
            fontFamily="mono"
            fontSize="11px"
            cursor="pointer"
            flexShrink={0}
            _hover={{ borderColor: 'term.red', color: 'term.red' }}
          >
            ×
          </Box>
        </Flex>
      ))}
    </Box>
  );
}
