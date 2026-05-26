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
        <Text fontSize="xs" color="term.ink3" fontFamily="mono">
          AI 分析中…
        </Text>
      </Flex>
    );
  }
  if (error !== null) {
    return (
      <Flex p="14px" align="center" justify="center" minH="120px">
        <Text fontSize="xs" color="fall" fontFamily="mono">
          {error}
        </Text>
      </Flex>
    );
  }
  if (analysis === null) {
    return (
      <Flex p="14px" align="center" justify="center" minH="120px">
        <Text fontSize="xs" color="term.ink3" fontFamily="mono">
          点击 ANALYZE 对最近 30 日记录进行复盘
        </Text>
      </Flex>
    );
  }

  const cm = analysis.coreMetrics;
  const bp = analysis.behavioralProfiling;
  return (
    <Flex direction="column" gap="12px" p="14px">
      <Section label="核心指标">
        <Metric k="胜率" v={fmtPct(cm.winRatePct)} />
        <Metric k="盈亏比" v={fmtNumOrNa(cm.pnlRatio)} />
        <Metric
          k="最大回撤"
          v={`${fmtPct(cm.maxDrawdown.valuePct)}  (${cm.maxDrawdown.startDate} → ${cm.maxDrawdown.endDate})`}
        />
        <Metric
          k="利润集中度"
          v={`${cm.profitConcentration.level}  ·  ${cm.profitConcentration.corePeriod}  ·  ${fmtPct(cm.profitConcentration.contributionPct)}`}
        />
        <Metric k="净资金流" v={`${cm.netCashFlow.status}  ${cm.netCashFlow.amount}`} />
      </Section>

      <Section label="行为画像">
        <Metric k="模式依赖" v={bp.patternDependency} />
        <Metric k="情绪波动" v={bp.emotionalVolatility} />
        {bp.disciplineBreaches.length > 0 && (
          <Box mt="4px">
            <Text
              fontSize="xs"
              letterSpacing="0.14em"
              color="term.ink3"
              fontFamily="mono"
              mb="2px"
            >
              纪律断层
            </Text>
            {bp.disciplineBreaches.map((b) => (
              <Text
                key={b.date}
                fontSize="xs"
                color="term.ink"
                fontFamily="mono"
                lineHeight="1.5"
              >
                {`${b.date}  ${fmtPct(b.pnlPct)}  ${b.analysis}`}
              </Text>
            ))}
          </Box>
        )}
      </Section>

      {analysis.marketMicrostructure.length > 0 && (
        <Section label="市场微观结构">
          {analysis.marketMicrostructure.map((p) => (
            <Text
              key={p.timeframe}
              fontSize="xs"
              color="term.ink"
              fontFamily="mono"
              lineHeight="1.5"
            >
              <Text as="span" color="accent">{`[${p.timeframe}] `}</Text>
              {p.environment}
            </Text>
          ))}
        </Section>
      )}

      {analysis.systemicInterventions.length > 0 && (
        <Section label="系统熔断规则">
          {analysis.systemicInterventions.map((iv) => (
            <Box key={iv.command} mb="6px">
              <Text fontSize="xs" color="rise" fontFamily="mono" fontWeight="700">
                {iv.command}
              </Text>
              <Text fontSize="xs" color="term.ink" fontFamily="mono" lineHeight="1.5">
                {`if (${iv.condition}) → ${iv.action}`}
              </Text>
              <Text fontSize="xs" color="term.ink3" fontFamily="mono" lineHeight="1.5">
                {iv.rationale}
              </Text>
            </Box>
          ))}
        </Section>
      )}

      <Text fontSize="xs" color="term.ink3" fontFamily="mono" letterSpacing="0.12em">
        {`${analysis.windowStart} → ${analysis.windowEnd}  ·  ${analysis.provider || 'unknown'}  ·  ${String(analysis.entryCount)} 条`}
      </Text>
    </Flex>
  );
}

function Section({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <Box>
      <Text
        fontSize="xs"
        letterSpacing="0.16em"
        color="accent"
        fontFamily="mono"
        fontWeight="700"
        mb="4px"
      >
        {label}
      </Text>
      <Flex direction="column" gap="2px">
        {children}
      </Flex>
    </Box>
  );
}

function Metric({ k, v }: { readonly k: string; readonly v: string }): React.ReactElement {
  return (
    <Flex gap="8px" fontFamily="mono" fontSize="sm" lineHeight="1.5">
      <Text color="term.ink3" minW="72px">
        {k}
      </Text>
      <Text color="term.ink" whiteSpace="pre-wrap" flex="1">
        {v}
      </Text>
    </Flex>
  );
}

function fmtPct(n: number): string {
  return `${n.toFixed(2)}%`;
}

function fmtNumOrNa(n: number | null): string {
  return n === null ? 'n/a' : n.toFixed(2);
}
