'use client';

/**
 * USR — single pane with three tabs in the header (LDG / WATCH / CFG).
 *
 * Replaces the historical trio of standalone panes (LDG.MAIN,
 * WATCH.LIVE, SYS.CFG) — see CLAUDE.md §2.5 (one Feat per pane). The
 * three sub-components keep their internal toolbars (tabs, action
 * buttons) so behaviour is preserved; the only thing this wrapper
 * adds is the tab strip in the header and a single shared FeatView
 * frame around them.
 *
 * Two render modes:
 *
 *   - Default (desktop topbar): wrapped in FeatView with the tab strip
 *     in the `right` slot. The pane uses `bodyOverlay` so its body
 *     floats as a dropdown anchored to the topbar header — there is no
 *     inline space in that slot to host an expanded body.
 *   - Mobile (`embedded="mobile"`): no FeatView chrome (the mobile
 *     shell already owns the screen). Tab strip renders as a top bar,
 *     body fills the rest of the height.
 */

import { Box, Flex } from '@chakra-ui/react';
import { useState } from 'react';

import { Feat } from '../../lib/eqty/feat.js';
import { FeatLedger } from '../feat-ledger/feat-ledger.js';
import { FeatSysCfg } from '../feat-sys-cfg/feat-sys-cfg.js';
import { FeatView } from '../feat-view/feat-view.js';
import { FeatWatchLive } from '../feat-watch-live/feat-watch-live.js';
import type { SessionChipInfo } from '../shell/app-shell.js';
import { UserChip } from '../shell/user-chip.js';

type Tab = 'ldg' | 'watch' | 'cfg';

const TAB_ORDER: ReadonlyArray<{ readonly id: Tab; readonly label: string }> = [
  { id: 'ldg', label: 'LDG' },
  { id: 'watch', label: 'WATCH' },
  { id: 'cfg', label: 'CFG' },
];

interface FeatUsrMainProps {
  /** `mobile` → render without FeatView chrome (the mobile shell owns
   *  the full screen). Default → desktop topbar pane. */
  readonly embedded?: 'mobile';
  /** Authenticated session — rendered as a chip in the tall header's
   *  top row (replaces the old standalone topbar slot). */
  readonly session?: SessionChipInfo | undefined;
}

export function FeatUsrMain({ embedded, session }: FeatUsrMainProps = {}): React.ReactElement {
  const [tab, setTab] = useState<Tab>('ldg');
  const tabs = (
    <Flex gap="2px">
      {TAB_ORDER.map((t) => (
        <TabButton
          key={t.id}
          active={tab === t.id}
          onClick={(): void => {
            setTab(t.id);
          }}
        >
          {t.label}
        </TabButton>
      ))}
    </Flex>
  );

  const body = (
    <Flex direction="column" flex="1" minH={0}>
      {tab === 'ldg' && <FeatLedger bare />}
      {tab === 'watch' && <FeatWatchLive bare />}
      {tab === 'cfg' && <FeatSysCfg bare />}
    </Flex>
  );

  if (embedded === 'mobile') {
    // Mobile: the bottom tab bar already owns navigation, so we render
    // only this Feat's three-tab strip + body and skip the FeatView
    // chrome (no minimize / fullscreen / bodyOverlay — those make no
    // sense when the pane *is* the screen).
    return (
      <Flex direction="column" h="100%" minH={0} bg="term.panel" color="term.ink2">
        <Flex
          align="center"
          gap="6px"
          px="10px"
          py="4px"
          borderBottomWidth="1px"
          borderColor="term.line"
          flexShrink={0}
        >
          {tabs}
        </Flex>
        {body}
      </Flex>
    );
  }

  return (
    <FeatView
      feat={Feat.UsrMain}
      tallHeader
      titleSlot={
        session !== undefined ? (
          <UserChip displayName={session.displayName} mode={session.mode} />
        ) : undefined
      }
      rightSecondary={tabs}
    >
      {body}
    </FeatView>
  );
}

interface TabButtonProps {
  readonly active: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}

function TabButton({ active, onClick, children }: TabButtonProps): React.ReactElement {
  return (
    <Box
      as="button"
      px="8px"
      py="2px"
      fontSize="10px"
      fontFamily="mono"
      letterSpacing="0.18em"
      fontWeight="700"
      color={active ? 'term.green' : 'term.ink3'}
      borderBottomWidth="1px"
      borderColor={active ? 'term.green' : 'transparent'}
      cursor="pointer"
      _hover={{ color: 'term.green' }}
      onClick={onClick}
    >
      {children}
    </Box>
  );
}
