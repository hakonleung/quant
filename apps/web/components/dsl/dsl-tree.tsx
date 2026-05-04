'use client';

/**
 * Renders a parsed DSL AST (modules/03-screening.md) as an
 * indentation-based tree so users can compare "what they typed" with
 * "what the parser understood".
 *
 * Operators and field/function tokens are clickable: a click toggles a
 * tooltip with the description from `lib/fp/dsl-docs.ts`. The
 * descriptions live in a pure-function module (zero IO) so server- and
 * client-side renderers share them.
 */

import { Box, Text } from '@chakra-ui/react';
import type {
  DslPredicate,
  DslScalar,
  ScreenPlanAst,
  UniverseExpr,
  UniversePlanAst,
} from '@quant/shared';
import { useState } from 'react';

import {
  describeAggregate,
  describeCompareOp,
  describeField,
  describeLogicalOp,
  describeNodeKind,
  describeStructural,
  type DslDoc,
} from '../../lib/fp/dsl-docs.js';

interface PlanProps {
  readonly screenPlan: ScreenPlanAst;
  readonly universePlan: UniversePlanAst | null;
}

export function DslTree({ screenPlan, universePlan }: PlanProps): React.ReactElement {
  return (
    <Box fontFamily="mono" fontSize="11px" color="ink2" lineHeight="1.7">
      {universePlan !== null && (
        <Section title="UNIVERSE" asof={universePlan.asof}>
          <UniverseNode node={universePlan.expr} depth={0} />
        </Section>
      )}
      <Section title="SCREEN" asof={screenPlan.asof}>
        <PredicateNode node={screenPlan.expr} depth={0} />
      </Section>
    </Box>
  );
}

interface SectionProps {
  readonly title: string;
  readonly asof: string;
  readonly children: React.ReactNode;
}

function Section({ title, asof, children }: SectionProps): React.ReactElement {
  return (
    <Box mb="8px">
      <Box
        fontFamily="mono"
        fontSize="9px"
        letterSpacing="0.18em"
        color="ink3"
        fontWeight="700"
        mb="4px"
      >
        {title} · asof {asof}
      </Box>
      {children}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// predicate tree
// ---------------------------------------------------------------------------

interface PredicateProps {
  readonly node: DslPredicate;
  readonly depth: number;
}

function PredicateNode({ node, depth }: PredicateProps): React.ReactElement {
  switch (node.kind) {
    case 'compare':
      return (
        <Indent depth={depth}>
          <ScalarNode node={node.left} />{' '}
          <Token doc={describeCompareOp(node.op)} accent>
            {describeCompareOp(node.op).title}
          </Token>{' '}
          <ScalarNode node={node.right} />
        </Indent>
      );
    case 'logical': {
      const doc = describeLogicalOp(node.op);
      return (
        <Box>
          <Indent depth={depth}>
            <Token doc={doc} accent>
              {doc.title}
            </Token>
          </Indent>
          {node.args.map((child, i) => (
            <PredicateNode key={i} node={child} depth={depth + 1} />
          ))}
        </Box>
      );
    }
    case 'for_all':
    case 'exists': {
      const doc = describeStructural(node.kind);
      return (
        <Box>
          <Indent depth={depth}>
            <Token doc={doc} accent>
              {doc.title}
            </Token>{' '}
            <Window days={node.window.days} />
          </Indent>
          <PredicateNode node={node.predicate} depth={depth + 1} />
        </Box>
      );
    }
    case 'consecutive': {
      const doc = describeStructural('consecutive');
      return (
        <Box>
          <Indent depth={depth}>
            <Token doc={doc} accent>
              {doc.title}
            </Token>{' '}
            <Text as="span" color="ink3">
              (min_len={node.min_len})
            </Text>
          </Indent>
          <PredicateNode node={node.predicate} depth={depth + 1} />
        </Box>
      );
    }
  }
}

function ScalarNode({ node }: { node: DslScalar }): React.ReactElement {
  switch (node.kind) {
    case 'field':
      return <Token doc={describeField(node.field)}>{describeField(node.field).title}</Token>;
    case 'const':
      return (
        <Text as="span" color="violet" fontWeight="600">
          {node.value}
        </Text>
      );
    case 'agg': {
      const aggDoc = describeAggregate(node.agg);
      return (
        <>
          <Token doc={aggDoc} accent>
            {node.agg}
          </Token>
          <Text as="span" color="ink3">
            (
          </Text>
          <Token doc={describeField(node.field)}>{describeField(node.field).title}</Token>
          <Text as="span" color="ink3">
            ,{' '}
          </Text>
          <Window days={node.window.days} />
          <Text as="span" color="ink3">
            )
          </Text>
        </>
      );
    }
    case 'period_return':
      return <PeriodReturnScalar days={node.window.days} />;
    case 'scale':
      return <ScaleScalar node={node} />;
  }
}

function PeriodReturnScalar({ days }: { days: number }): React.ReactElement {
  const doc = describeNodeKind('period_return');
  return (
    <>
      <Token doc={doc} accent>
        period_return
      </Token>
      <Text as="span" color="ink3">
        (
      </Text>
      <Window days={days} />
      <Text as="span" color="ink3">
        )
      </Text>
    </>
  );
}

function ScaleScalar({
  node,
}: {
  node: Extract<DslScalar, { kind: 'scale' }>;
}): React.ReactElement {
  const doc = describeNodeKind('scale');
  return (
    <>
      <Token doc={doc} accent>
        scale
      </Token>
      <Text as="span" color="ink3">
        (
      </Text>
      <ScalarNode node={node.inner} />
      <Text as="span" color="ink3">
        ,{' '}
      </Text>
      <Text as="span" color="violet" fontWeight="600">
        {node.factor}
      </Text>
      <Text as="span" color="ink3">
        )
      </Text>
    </>
  );
}

// ---------------------------------------------------------------------------
// universe tree (separate AST shape — string fields, scalar consts)
// ---------------------------------------------------------------------------

interface UniverseProps {
  readonly node: UniverseExpr;
  readonly depth: number;
}

function UniverseNode({ node, depth }: UniverseProps): React.ReactElement {
  if (node.kind === 'logical') {
    const doc = describeLogicalOp(node.op);
    return (
      <Box>
        <Indent depth={depth}>
          <Token doc={doc} accent>
            {doc.title}
          </Token>
        </Indent>
        {node.args.map((child, i) => (
          <UniverseNode key={i} node={child} depth={depth + 1} />
        ))}
      </Box>
    );
  }
  return (
    <Indent depth={depth}>
      <Token doc={describeField(node.left.field)}>{describeField(node.left.field).title}</Token>{' '}
      <Token doc={describeCompareOp(node.op)} accent>
        {describeCompareOp(node.op).title}
      </Token>{' '}
      <Text as="span" color="violet" fontWeight="600">
        {String(node.right.value)}
      </Text>
    </Indent>
  );
}

// ---------------------------------------------------------------------------
// presentation primitives
// ---------------------------------------------------------------------------

function Indent({
  depth,
  children,
}: {
  depth: number;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box pl={`${String(depth * 16)}px`}>
      {depth > 0 && (
        <Text as="span" color="ink3" mr="4px">
          ├
        </Text>
      )}
      {children}
    </Box>
  );
}

function Window({ days }: { days: number }): React.ReactElement {
  return (
    <Text as="span" color="ink3">
      {String(days)}d
    </Text>
  );
}

interface TokenProps {
  readonly doc: DslDoc;
  readonly children: React.ReactNode;
  readonly accent?: boolean;
}

/**
 * A click-to-toggle tooltip token. Click again (or click another
 * token) to dismiss. We don't auto-dismiss on hover-out because the
 * description text is sometimes long enough to warrant reading at
 * leisure.
 */
function Token({ doc, children, accent = false }: TokenProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <Box
      as="span"
      position="relative"
      cursor="pointer"
      color={accent ? 'accent' : 'ink'}
      fontWeight={accent ? '700' : '600'}
      borderBottomWidth="1px"
      borderBottomStyle="dotted"
      borderBottomColor={accent ? 'accent' : 'ink3'}
      onClick={(e): void => {
        e.stopPropagation();
        setOpen((v) => !v);
      }}
    >
      {children}
      {open && (
        <Box
          position="absolute"
          top="100%"
          left="0"
          mt="4px"
          zIndex={20}
          minW="220px"
          maxW="320px"
          bg="panel"
          borderWidth="1px"
          borderColor="accent"
          boxShadow="md"
          p="8px 10px"
          fontFamily="mono"
          fontSize="10px"
          color="ink2"
          letterSpacing="0.04em"
          lineHeight="1.5"
        >
          <Text color="accent" fontWeight="700" mb="2px">
            {doc.title}
          </Text>
          <Text>{doc.description}</Text>
          {doc.example !== undefined && (
            <Text mt="4px" color="ink3">
              e.g. {doc.example}
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}
