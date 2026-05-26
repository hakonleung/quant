'use client';

/**
 * Pane-interior section primitives — paired with `<FeatView>` to keep
 * every Feat's internal chrome (sub-headers, tool strips, dialog
 * headers) painted from a single source of truth.
 *
 * Before these existed, each Feat hand-rolled a `<Flex px py border bg
 * + caps mono Text>` strip and drifted on bg (`panel3` /
 * `glass.panelSoft` / `term.bgElev`), border (`line` / `glass.line` /
 * `term.line`), padding, and font tracking. The result was that two
 * panes side-by-side never quite looked like siblings.
 *
 * Use:
 *   - `<FeatSectionBar name="SCR.PAT" right={...} />` — divider strip
 *     with a caps mono name on the left and an optional right slot.
 *     Default surface is `glass.panelSoft` (frosted, lets the wallpaper
 *     read through); cyber Feats pass `cyber` and get the term
 *     palette.
 *   - `<FeatSectionLabel>theme</FeatSectionLabel>` — the bare caps
 *     mono heading used inside section bodies (no border, no padding).
 *
 * Dialogs reuse `<FeatSectionBar>` as their header: pass `id` for the
 * `aria-labelledby` reference.
 */

import { Box, Flex, Text } from '@chakra-ui/react';
import type { ReactNode } from 'react';

export type FeatSectionTone = 'soft' | 'transparent';

interface FeatSectionBarProps {
  /** Accent caps-mono label on the left. Omit for a pure toolbar strip. */
  readonly name?: string;
  /** Secondary caption (smaller, ink2) rendered next to the name. */
  readonly subtitle?: ReactNode;
  /** Right-aligned slot — usually `<MonoButton>`s. */
  readonly right?: ReactNode;
  /** Surface variant. `soft` (default) = `glass.panelSoft` + blur; `transparent` = no fill. */
  readonly tone?: FeatSectionTone;
  /** Cyber/term variant — swaps to the term palette. */
  readonly cyber?: boolean;
  /** DOM id — wire to a dialog's `aria-labelledby`. */
  readonly id?: string;
  /** Render content instead of the standard name/subtitle layout. */
  readonly children?: ReactNode;
}

/**
 * Standard pane-interior divider strip. Equivalent to the old hand-
 * rolled `<Flex px="10-14" py="6-8" borderBottomWidth gx bg="panel3"
 * + mono caps Text>`, with bg/border/typography fixed to the
 * project's Liquid Glass tokens.
 */
export function FeatSectionBar({
  name,
  subtitle,
  right,
  tone = 'soft',
  cyber = false,
  id,
  children,
}: FeatSectionBarProps): React.ReactElement {
  const bg = tone === 'transparent' ? 'transparent' : cyber ? 'term.bgElev' : 'glass.panelSoft';
  const borderColor = cyber ? 'term.line' : 'glass.line';
  return (
    <Flex
      id={id}
      align="center"
      gap="10px"
      px="14px"
      py="6px"
      borderBottomWidth="1px"
      borderColor={borderColor}
      bg={bg}
      // Frosted strip — backdropFilter only applies when the bg has
      // alpha (i.e. `soft`); skip it on `transparent` so we don't
      // pay for an unused composite.
      {...(tone === 'soft' ? { backdropFilter: 'blur(12px)' } : {})}
      flexShrink={0}
      color={cyber ? 'term.ink3' : 'ink3'}
    >
      {children ?? (
        <>
          {name !== undefined && (
            <Text
              fontFamily="mono"
              fontSize="xs"
              letterSpacing="0.18em"
              textTransform="uppercase"
              fontWeight="700"
              color="accent"
              whiteSpace="nowrap"
              flexShrink={0}
            >
              {name}
            </Text>
          )}
          {subtitle !== undefined && (
            <Box
              fontFamily="mono"
              fontSize="xs"
              letterSpacing="0.10em"
              color={cyber ? 'term.ink3' : 'ink3'}
              minW={0}
              flex="1"
              overflow="hidden"
              textOverflow="ellipsis"
              whiteSpace="nowrap"
            >
              {subtitle}
            </Box>
          )}
          {subtitle === undefined && <Box flex="1" />}
          {right !== undefined && (
            <Flex align="center" gap="6px" flexShrink={0}>
              {right}
            </Flex>
          )}
        </>
      )}
    </Flex>
  );
}

interface FeatSectionLabelProps {
  readonly cyber?: boolean;
  readonly children: ReactNode;
}

/**
 * Bare caps-mono heading used inside section bodies (no border, no
 * padding). Pairs with `<FeatSectionBar>` for the case where you've
 * already opened a body region and just want a sub-heading.
 */
export function FeatSectionLabel({
  cyber = false,
  children,
}: FeatSectionLabelProps): React.ReactElement {
  return (
    <Text
      fontFamily="mono"
      fontSize="xs"
      letterSpacing="0.18em"
      textTransform="uppercase"
      fontWeight="700"
      color={cyber ? 'term.ink3' : 'ink3'}
    >
      {children}
    </Text>
  );
}
