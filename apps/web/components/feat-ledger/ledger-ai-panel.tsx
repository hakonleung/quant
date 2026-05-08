'use client';

import { Box, Flex, Text } from '@chakra-ui/react';
import type { LedgerAnalysis } from '@quant/shared';

interface LedgerAiPanelProps {
  readonly analysis: LedgerAnalysis | null;
  readonly loading: boolean;
  readonly error: string | null;
}

export function LedgerAiPanel({
  analysis,
  loading,
  error,
}: LedgerAiPanelProps): React.ReactElement {
  if (loading) {
    return (
      <Flex p="14px" align="center" justify="center" minH="120px">
        <Text fontSize="11px" color="ink3" fontFamily="mono">
          AI 分析中…
        </Text>
      </Flex>
    );
  }
  if (error !== null) {
    return (
      <Flex p="14px" align="center" justify="center" minH="120px">
        <Text fontSize="11px" color="fall" fontFamily="mono">
          {error}
        </Text>
      </Flex>
    );
  }
  if (analysis === null) {
    return (
      <Flex p="14px" align="center" justify="center" minH="120px">
        <Text fontSize="11px" color="ink3" fontFamily="mono">
          点击 ANALYZE 对最近 30 日记录进行复盘
        </Text>
      </Flex>
    );
  }

  return (
    <Flex direction="column" gap="10px" p="14px">
      <Block label="SUMMARY" body={analysis.summary} />
      <Block label="操作风格" body={analysis.operationStyle} />
      <Block label="市场观察" body={analysis.marketView} />
      {analysis.recommendations.length > 0 && (
        <Block
          label="建议"
          body={analysis.recommendations.map((r, i) => `${String(i + 1)}. ${r}`).join('\n')}
        />
      )}
      <Text fontSize="9px" color="ink3" fontFamily="mono" letterSpacing="0.12em">
        {`${analysis.windowStart} → ${analysis.windowEnd}  ·  ${analysis.provider || 'unknown'}  ·  ${String(analysis.entryCount)} 条`}
      </Text>
    </Flex>
  );
}

function Block({
  label,
  body,
}: {
  readonly label: string;
  readonly body: string;
}): React.ReactElement {
  return (
    <Box>
      <Text
        fontSize="9px"
        letterSpacing="0.16em"
        color="accent"
        fontFamily="mono"
        fontWeight="700"
        mb="2px"
      >
        {label}
      </Text>
      <Text fontSize="12px" color="ink" whiteSpace="pre-wrap" lineHeight="1.5">
        {body}
      </Text>
    </Box>
  );
}
