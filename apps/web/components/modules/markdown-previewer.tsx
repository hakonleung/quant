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
 * The first consumer is A-0 (`StdoutPanel`) flipping into preview mode
 * to render `Sentiment.result` (the verbatim analyst write-up returned
 * by the web-search pass). The component itself does not know about
 * sentiment; pass any markdown text in.
 */

import { Box, Text } from '@chakra-ui/react';
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { Feat } from '../../lib/eqty/feat.js';
import { Pane } from '../shell/pane.js';

interface MarkdownPreviewerProps {
  /** Markdown source. Empty string renders the idle hint. */
  readonly source: string;
  /** Right-slot of the pane header — typically a back / close button. */
  readonly headerRight?: ReactNode;
}

const PROSE_TEXT_STYLE = {
  color: 'term.ink',
  fontFamily: 'mono' as const,
  fontSize: '12.5px',
  lineHeight: '1.7',
} as const;

export function MarkdownPreviewer({
  source,
  headerRight,
}: MarkdownPreviewerProps): React.ReactElement {
  const trimmed = source.trim();
  return (
    <Pane feat={Feat.Markdown} {...(headerRight !== undefined ? { right: headerRight } : {})}>
      <Box
        position="relative"
        px="18px"
        py="14px"
        bg="term.panel"
        h="100%"
        overflow="auto"
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
          <Box position="relative" zIndex={1} {...PROSE_TEXT_STYLE}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={MARKDOWN_COMPONENTS}
            >
              {source}
            </ReactMarkdown>
          </Box>
        )}
      </Box>
    </Pane>
  );
}

// Inline component overrides — keep all element styling here so the
// terminal palette is the single source of truth and we do not depend
// on a global `.prose` stylesheet.
const MARKDOWN_COMPONENTS = {
  h1: (p: { readonly children?: ReactNode }): React.ReactElement => (
    <Text
      as="h1"
      color="term.green"
      fontFamily="mono"
      fontSize="16px"
      fontWeight="700"
      letterSpacing="0.04em"
      mt="18px"
      mb="10px"
    >
      {p.children}
    </Text>
  ),
  h2: (p: { readonly children?: ReactNode }): React.ReactElement => (
    <Text
      as="h2"
      color="term.green"
      fontFamily="mono"
      fontSize="14px"
      fontWeight="700"
      letterSpacing="0.04em"
      mt="14px"
      mb="8px"
    >
      {p.children}
    </Text>
  ),
  h3: (p: { readonly children?: ReactNode }): React.ReactElement => (
    <Text
      as="h3"
      color="accent"
      fontFamily="mono"
      fontSize="13px"
      fontWeight="700"
      letterSpacing="0.04em"
      mt="12px"
      mb="6px"
    >
      {p.children}
    </Text>
  ),
  h4: (p: { readonly children?: ReactNode }): React.ReactElement => (
    <Text as="h4" color="term.ink" fontFamily="mono" fontSize="12.5px" fontWeight="700" mt="10px" mb="4px">
      {p.children}
    </Text>
  ),
  p: (p: { readonly children?: ReactNode }): React.ReactElement => (
    <Text as="p" color="term.ink" mt="6px" mb="6px">
      {p.children}
    </Text>
  ),
  strong: (p: { readonly children?: ReactNode }): React.ReactElement => (
    <Text as="strong" color="term.ink" fontWeight="700">
      {p.children}
    </Text>
  ),
  em: (p: { readonly children?: ReactNode }): React.ReactElement => (
    <Text as="em" color="term.ink2" fontStyle="italic">
      {p.children}
    </Text>
  ),
  ul: (p: { readonly children?: ReactNode }): React.ReactElement => (
    <Box as="ul" pl="18px" mt="4px" mb="8px" css={{ listStyleType: 'disc' }}>
      {p.children}
    </Box>
  ),
  ol: (p: { readonly children?: ReactNode }): React.ReactElement => (
    <Box as="ol" pl="18px" mt="4px" mb="8px" css={{ listStyleType: 'decimal' }}>
      {p.children}
    </Box>
  ),
  li: (p: { readonly children?: ReactNode }): React.ReactElement => (
    <Box as="li" color="term.ink" mt="2px" mb="2px">
      {p.children}
    </Box>
  ),
  blockquote: (p: { readonly children?: ReactNode }): React.ReactElement => (
    <Box
      as="blockquote"
      borderLeftWidth="2px"
      borderLeftColor="accent"
      pl="10px"
      py="2px"
      my="8px"
      color="term.ink2"
    >
      {p.children}
    </Box>
  ),
  code: (p: {
    readonly children?: ReactNode;
    readonly className?: string | undefined;
  }): React.ReactElement => {
    const isBlock = p.className !== undefined && p.className.startsWith('language-');
    if (isBlock) {
      return (
        <Box
          as="code"
          display="block"
          bg="term.bg"
          borderWidth="1px"
          borderColor="line"
          color="term.ink"
          p="8px 10px"
          my="8px"
          fontSize="11.5px"
          overflow="auto"
        >
          {p.children}
        </Box>
      );
    }
    return (
      <Box
        as="code"
        bg="term.bg"
        color="accent"
        px="4px"
        py="1px"
        fontSize="11.5px"
        borderWidth="1px"
        borderColor="line"
      >
        {p.children}
      </Box>
    );
  },
  pre: (p: { readonly children?: ReactNode }): React.ReactElement => (
    <Box as="pre" my="8px" overflow="auto">
      {p.children}
    </Box>
  ),
  table: (p: { readonly children?: ReactNode }): React.ReactElement => (
    <Box
      as="table"
      w="100%"
      mt="8px"
      mb="10px"
      borderWidth="1px"
      borderColor="line"
      borderCollapse="collapse"
      fontSize="11.5px"
    >
      {p.children}
    </Box>
  ),
  thead: (p: { readonly children?: ReactNode }): React.ReactElement => (
    <Box as="thead" bg="panel" color="term.green">
      {p.children}
    </Box>
  ),
  tbody: (p: { readonly children?: ReactNode }): React.ReactElement => <Box as="tbody">{p.children}</Box>,
  tr: (p: { readonly children?: ReactNode }): React.ReactElement => (
    <Box as="tr" borderTopWidth="1px" borderTopColor="line">
      {p.children}
    </Box>
  ),
  th: (p: { readonly children?: ReactNode }): React.ReactElement => (
    <Box
      as="th"
      px="8px"
      py="4px"
      textAlign="left"
      borderRightWidth="1px"
      borderRightColor="line"
      fontWeight="700"
    >
      {p.children}
    </Box>
  ),
  td: (p: { readonly children?: ReactNode }): React.ReactElement => (
    <Box as="td" px="8px" py="4px" borderRightWidth="1px" borderRightColor="line">
      {p.children}
    </Box>
  ),
  a: (p: { readonly children?: ReactNode; readonly href?: string | undefined }): React.ReactElement => (
    <a
      href={p.href}
      target="_blank"
      rel="noreferrer noopener"
      style={{ color: 'var(--colors-accent, currentColor)', textDecoration: 'underline' }}
    >
      {p.children}
    </a>
  ),
  hr: (): React.ReactElement => (
    <Box as="hr" border="0" borderTopWidth="1px" borderTopColor="line" my="10px" />
  ),
};
