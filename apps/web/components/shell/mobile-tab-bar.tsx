'use client';

/**
 * Bottom tab bar — only mounted by the mobile shell (viewport < 768px).
 *
 * Five Feats are first-class on phones; everything else is reachable
 * either from inside one of these (e.g. SEC.LIST chip strip lives at
 * the top of `list`) or via the topbar overlays (CHN, SYS.CFG).
 * Keeping the count at five matches Apple/Material guidance and lets
 * each label keep a 44px-square hot zone on a 320px viewport.
 *
 * The active tab is persisted via `useUiStore.mobileTab` so a refresh
 * keeps the user on the same Feat.
 */

import { Box, Flex, Text } from '@chakra-ui/react';

import { useUiStore, type MobileTab } from '../../lib/stores/ui.store.js';

interface TabSpec {
  readonly id: MobileTab;
  readonly label: string;
}

const TABS: readonly TabSpec[] = [
  { id: 'list', label: 'LIST' },
  { id: 'chart', label: 'CHART' },
  { id: 'ai', label: 'AI' },
  { id: 'sys', label: 'SYS' },
  { id: 'usr', label: 'USR' },
];

export function MobileTabBar(): React.ReactElement {
  const active = useUiStore((s) => s.mobileTab);
  const setTab = useUiStore((s) => s.setMobileTab);
  return (
    <Flex
      as="nav"
      aria-label="主导航"
      role="tablist"
      borderTopWidth="1px"
      borderTopColor="line"
      bg="panel"
      flexShrink={0}
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {TABS.map((t) => (
        <TabButton
          key={t.id}
          spec={t}
          active={active === t.id}
          onSelect={(): void => {
            setTab(t.id);
          }}
        />
      ))}
    </Flex>
  );
}

interface TabButtonProps {
  readonly spec: TabSpec;
  readonly active: boolean;
  readonly onSelect: () => void;
}

function TabButton({ spec, active, onSelect }: TabButtonProps): React.ReactElement {
  return (
    <Box
      as="button"
      role="tab"
      aria-selected={active}
      aria-label={spec.label}
      onClick={onSelect}
      flex="1"
      minH="48px"
      display="flex"
      alignItems="center"
      justifyContent="center"
      bg="transparent"
      borderTopWidth="2px"
      borderTopColor={active ? 'accent' : 'transparent'}
      cursor="pointer"
      // Mono chrome — keep the press feedback obvious on touch since
      // hover effects don't fire on phones.
      _active={{ bg: 'panel3' }}
      _focusVisible={{ outline: '2px solid', outlineColor: 'accent', outlineOffset: '-2px' }}
    >
      <Text
        fontFamily="mono"
        fontSize="xs"
        letterSpacing="0.16em"
        fontWeight={active ? '700' : '500'}
        color={active ? 'accent' : 'ink2'}
      >
        {spec.label}
      </Text>
    </Box>
  );
}
