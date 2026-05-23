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

import { Box, Flex, Text } from '@chakra-ui/react';
import { useState } from 'react';

import { Feat } from '../../lib/eqty/feat.js';
import { BUILTIN_PRESETS, useLayoutStore } from '../../lib/stores/layout.store.js';
import {
  useSettingsStore,
  type ColumnFilterScope,
  type DragDirection,
  type ThemeMode,
} from '../../lib/stores/settings.store.js';
import { ColumnManager } from '../feat-eq-list/column-manager.js';
import { FeatView } from '../feat-view/feat-view.js';

type Section = 'theme' | 'gestures' | 'presets' | 'columns' | 'filters';

const SECTIONS: ReadonlyArray<{
  readonly id: Section;
  readonly label: string;
}> = [
  { id: 'theme', label: 'theme' },
  { id: 'gestures', label: 'gestures' },
  { id: 'presets', label: 'presets' },
  { id: 'columns', label: 'columns' },
  { id: 'filters', label: 'filters' },
];

interface FeatSysCfgProps {
  /** Hosted inside USR.MAIN as a tab — drop the FeatView chrome. */
  readonly bare?: boolean;
}

export function FeatSysCfg({ bare }: FeatSysCfgProps = {}): React.ReactElement {
  const [section, setSection] = useState<Section>('theme');

  return (
    <FeatView feat={Feat.SysCfg} bare={bare ?? false}>
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
          {section === 'theme' && <ThemeSection />}
          {section === 'gestures' && <GesturesSection />}
          {section === 'presets' && <PresetsSection />}
          {section === 'columns' && <ColumnManager />}
          {section === 'filters' && <FiltersSection />}
        </Box>
      </Flex>
    </FeatView>
  );
}

interface ThemeOption {
  readonly id: ThemeMode;
  readonly label: string;
  readonly description: string;
}

const THEME_OPTIONS: readonly ThemeOption[] = [
  {
    id: 'light',
    label: '浅色（日间）',
    description: '默认 — 浅灰底 + 琥珀点缀，盘中长时间可读。',
  },
  {
    id: 'dark',
    label: '深色（夜盘）',
    description:
      '深色工作台（≠ TERM 的极客绿）— 仍是琥珀点缀，更柔和的 up / down 配色，弱光环境减少眩光。',
  },
];

function ThemeSection(): React.ReactElement {
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  return (
    <Flex direction="column" p="12px" gap="8px">
      <Text
        fontSize="9px"
        letterSpacing="0.18em"
        color="term.ink3"
        textTransform="uppercase"
        fontWeight="700"
      >
        theme
      </Text>
      {THEME_OPTIONS.map((opt) => {
        const selected = theme === opt.id;
        return (
          <Box
            key={opt.id}
            as="button"
            onClick={(): void => {
              setTheme(opt.id);
            }}
            textAlign="left"
            p="10px"
            borderWidth="1px"
            borderColor={selected ? 'term.green' : 'term.line'}
            bg={selected ? 'term.bgElev' : 'transparent'}
            color="term.ink"
            cursor="pointer"
            _hover={{ borderColor: 'term.green', color: 'term.green' }}
          >
            <Flex align="baseline" gap="8px">
              <Text fontSize="12px" fontWeight="700" color={selected ? 'term.green' : 'term.ink'}>
                {opt.label}
              </Text>
              {selected && (
                <Text fontSize="9px" color="term.green" letterSpacing="0.18em" ml="auto">
                  ACTIVE
                </Text>
              )}
            </Flex>
            <Text fontSize="11px" color="term.ink2" mt="4px" lineHeight="1.5">
              {opt.description}
            </Text>
          </Box>
        );
      })}
      <Text fontSize="10px" color="term.ink3" mt="4px" lineHeight="1.5">
        // 首次访问读系统 prefers-color-scheme，之后这里的选择会写回 sys-cfg。
      </Text>
    </Flex>
  );
}

interface DragOption {
  readonly id: DragDirection;
  readonly label: string;
  readonly description: string;
}

const DRAG_OPTIONS: readonly DragOption[] = [
  {
    id: 'inverted',
    label: '反向（默认）',
    description: '左拖拽显示右边内容 — 经典桌面滚动条手感，内容相对光标反向滑动。',
  },
  {
    id: 'natural',
    label: '同向',
    description: '左拖拽显示左边内容 — 抓住的内容跟随光标移动，类似触摸板/移动端。',
  },
];

function GesturesSection(): React.ReactElement {
  const direction = useSettingsStore((s) => s.dragDirection);
  const setDirection = useSettingsStore((s) => s.setDragDirection);
  return (
    <Flex direction="column" p="12px" gap="8px">
      <Text
        fontSize="9px"
        letterSpacing="0.18em"
        color="term.ink3"
        textTransform="uppercase"
        fontWeight="700"
      >
        chart drag
      </Text>
      {DRAG_OPTIONS.map((opt) => {
        const selected = direction === opt.id;
        return (
          <Box
            key={opt.id}
            as="button"
            onClick={(): void => {
              setDirection(opt.id);
            }}
            textAlign="left"
            p="10px"
            borderWidth="1px"
            borderColor={selected ? 'term.green' : 'term.line'}
            bg={selected ? 'term.bgElev' : 'transparent'}
            color="term.ink"
            cursor="pointer"
            _hover={{ borderColor: 'term.green', color: 'term.green' }}
          >
            <Flex align="baseline" gap="8px">
              <Text fontSize="12px" fontWeight="700" color={selected ? 'term.green' : 'term.ink'}>
                {opt.label}
              </Text>
              {selected && (
                <Text fontSize="9px" color="term.green" letterSpacing="0.18em" ml="auto">
                  ACTIVE
                </Text>
              )}
            </Flex>
            <Text fontSize="11px" color="term.ink2" mt="4px" lineHeight="1.5">
              {opt.description}
            </Text>
          </Box>
        );
      })}
      <Text fontSize="10px" color="term.ink3" mt="4px" lineHeight="1.5">
        // 影响 EQ.CHART 与 LDG.MAIN 的日线 / 累计图拖拽方向。
      </Text>
    </Flex>
  );
}

function PresetsSection(): React.ReactElement {
  const activeId = useLayoutStore((s) => s.activePresetId);
  const apply = useLayoutStore((s) => s.applyPreset);
  return (
    <Flex direction="column" p="12px" gap="8px">
      <Text
        fontSize="9px"
        letterSpacing="0.18em"
        color="term.ink3"
        textTransform="uppercase"
        fontWeight="700"
      >
        layout presets
      </Text>
      {BUILTIN_PRESETS.map((p) => {
        const selected = activeId === p.id;
        return (
          <Box
            key={p.id}
            as="button"
            onClick={(): void => {
              apply(p.id);
            }}
            textAlign="left"
            p="10px"
            borderWidth="1px"
            borderColor={selected ? 'term.green' : 'term.line'}
            bg={selected ? 'term.bgElev' : 'transparent'}
            color="term.ink"
            cursor="pointer"
            _hover={{ borderColor: 'term.green', color: 'term.green' }}
          >
            <Flex align="baseline" gap="8px">
              <Text fontSize="12px" fontWeight="700" color={selected ? 'term.green' : 'term.ink'}>
                {p.label}
              </Text>
              <Text fontSize="9px" color="term.ink3" letterSpacing="0.12em">
                {p.id}
              </Text>
              {selected && (
                <Text fontSize="9px" color="term.green" letterSpacing="0.18em" ml="auto">
                  ACTIVE
                </Text>
              )}
            </Flex>
            {p.description !== undefined && (
              <Text fontSize="11px" color="term.ink2" mt="4px" lineHeight="1.5">
                {p.description}
              </Text>
            )}
          </Box>
        );
      })}
      <Text fontSize="10px" color="term.ink3" mt="4px" lineHeight="1.5">
        // 提示：拖动列宽或最小化任意面板会清掉 ACTIVE 标记 — //
        预设只是一次性的状态注入，之后是用户自由布局。
      </Text>
    </Flex>
  );
}

interface FilterScopeOption {
  readonly id: ColumnFilterScope;
  readonly label: string;
  readonly description: string;
}

const FILTER_SCOPE_OPTIONS: readonly FilterScopeOption[] = [
  {
    id: 'all-sectors',
    label: '所有板块（默认）',
    description: '列筛选预设对每一个板块视图都生效——用户板块 / 动态筛选板块同样会被过滤。',
  },
  {
    id: 'all-only',
    label: '仅 sector all 生效',
    description:
      '列筛选只作用于合成的 “All” 板块；用户板块与动态板块保持原样、不被前端过滤。',
  },
];

function FiltersSection(): React.ReactElement {
  const scope = useSettingsStore((s) => s.columnFilterScope);
  const setScope = useSettingsStore((s) => s.setColumnFilterScope);
  return (
    <Flex direction="column" p="12px" gap="8px">
      <Text
        fontSize="9px"
        letterSpacing="0.18em"
        color="term.ink3"
        textTransform="uppercase"
        fontWeight="700"
      >
        column filter scope
      </Text>
      {FILTER_SCOPE_OPTIONS.map((opt) => {
        const selected = scope === opt.id;
        return (
          <Box
            key={opt.id}
            as="button"
            onClick={(): void => {
              setScope(opt.id);
            }}
            textAlign="left"
            p="10px"
            borderWidth="1px"
            borderColor={selected ? 'term.green' : 'term.line'}
            bg={selected ? 'term.bgElev' : 'transparent'}
            color="term.ink"
            cursor="pointer"
            _hover={{ borderColor: 'term.green', color: 'term.green' }}
          >
            <Flex align="baseline" gap="8px">
              <Text fontSize="12px" fontWeight="700" color={selected ? 'term.green' : 'term.ink'}>
                {opt.label}
              </Text>
              {selected && (
                <Text fontSize="9px" color="term.green" letterSpacing="0.18em" ml="auto">
                  ACTIVE
                </Text>
              )}
            </Flex>
            <Text fontSize="11px" color="term.ink2" mt="4px" lineHeight="1.5">
              {opt.description}
            </Text>
          </Box>
        );
      })}
      <Text fontSize="10px" color="term.ink3" mt="4px" lineHeight="1.5">
        // 在 columns 区域配置的列筛选阈值，按此作用域应用到 EQ.LIST。
      </Text>
    </Flex>
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
