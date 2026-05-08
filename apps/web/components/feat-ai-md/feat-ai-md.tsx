'use client';

/**
 * A-2 — Markdown previewer.
 *
 * Generic, content-agnostic surface that takes a markdown string and
 * renders it inside the workbench terminal aesthetic. Headings collapse
 * to the same size hierarchy used by the rest of the EQTY panes;
 * tables, lists and code blocks pick up the mono palette so the result
 * reads like the rest of the workbench.
 *
 * The first consumer is AI.EQ (`FeatAiEq`) flipping into preview mode
 * to render `Sentiment.result` (the verbatim analyst write-up returned
 * by the web-search pass). The component itself does not know about
 * sentiment; pass any markdown text in.
 *
 * **Code-splitting:** the heavy `react-markdown` + `remark-gfm` chunk
 * lives in `markdown-body.tsx` and is pulled in via `next/dynamic`.
 * The pane shell (header, scroll container, idle hint) is eagerly
 * loaded so the user sees the chrome immediately on first paint; the
 * markdown bundle only downloads when there is non-empty content.
 */

import { Box, Text } from '@chakra-ui/react';
import dynamic from 'next/dynamic';
import type { ReactNode } from 'react';

import { Feat } from '../../lib/eqty/feat.js';
import { FeatView } from '../feat-view/feat-view.js';

const MarkdownBody = dynamic(
  () => import('./markdown-body.js').then((m) => ({ default: m.MarkdownBody })),
  {
    ssr: false,
    loading: () => (
      <Text color="term.ink3" fontFamily="mono" fontSize="12.5px">
        // loading…
      </Text>
    ),
  },
);

interface MarkdownPreviewerProps {
  /** Markdown source. Empty string renders the idle hint. */
  readonly source: string;
  /** Right-slot of the pane header — typically a back / close button. */
  readonly headerRight?: ReactNode;
  /** Display label appended to the pane title (e.g. stock or sector name). */
  readonly subject?: string;
}

const PROSE_TEXT_STYLE = {
  color: 'term.ink',
  fontFamily: 'mono' as const,
  fontSize: '12.5px',
  lineHeight: '1.7',
} as const;

export function FeatAiMd({
  source,
  headerRight,
  subject,
}: MarkdownPreviewerProps): React.ReactElement {
  const trimmed = source.trim();
  const titleSlot =
    subject !== undefined && subject.length > 0 ? (
      <Text
        fontFamily="mono"
        fontSize="11px"
        letterSpacing="0.06em"
        color="term.ink2"
        whiteSpace="nowrap"
      >
        {subject}
      </Text>
    ) : undefined;
  return (
    <FeatView
      feat={Feat.AIMd}
      {...(titleSlot !== undefined ? { titleSlot } : {})}
      {...(headerRight !== undefined ? { right: headerRight } : {})}
    >
      <Box
        position="relative"
        flex="1"
        minH={0}
        overflow="auto"
        px="18px"
        py="14px"
        bg="term.panel"
        _after={{
          content: '""',
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          background:
            'repeating-linear-gradient(to bottom, rgba(255,255,255,0.012) 0 1px, transparent 1px 3px)',
        }}
      >
        {trimmed.length === 0 ? (
          <Text {...PROSE_TEXT_STYLE} color="term.ink3">
            // no content
          </Text>
        ) : (
          <MarkdownBody source={source} />
        )}
      </Box>
    </FeatView>
  );
}
