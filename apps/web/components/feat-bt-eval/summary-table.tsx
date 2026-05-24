'use client';

/**
 * Per-holding summary table with Chinese headers + native title-tooltip
 * for each metric. Row click toggles the per-holding observations panel
 * inside the parent Results component.
 */

import { Box } from '@chakra-ui/react';
import type { BacktestEvaluateResponse, BacktestSpreadSummary } from '@quant/shared';

import { Cell } from './cell.js';

interface SummaryHeader {
  readonly key: string;
  readonly label: string;
  readonly title: string;
  readonly align: 'left' | 'right';
}

const SUMMARY_HEADERS: readonly SummaryHeader[] = [
  { key: 'hold', label: '持仓', title: 'hold: 持仓交易日数 N', align: 'left' },
  { key: 'n', label: '样本数', title: 'n: 进入分布的观察数', align: 'right' },
  { key: 'mean', label: '均值', title: 'mean: 该持仓期收益的算术平均', align: 'right' },
  { key: 'median', label: '中位数', title: 'median: 该持仓期收益的中位数, 抗极值', align: 'right' },
  { key: 'win', label: '胜率', title: 'win: 该持仓期内收益>0 的比例', align: 'right' },
  {
    key: 'vs-univ',
    label: '超额(对全市场)',
    title: 'vs univ: 选股相对全市场基准的平均日内超额收益',
    align: 'right',
  },
  {
    key: 't',
    label: 't 值',
    title: 't 值: 选股相对全市场的显著性, |t|>2 视为显著',
    align: 'right',
  },
  {
    key: 'sharpe',
    label: '类夏普',
    title: 'sharpe: 均值 / 标准差, 近似单位风险收益, 未年化',
    align: 'right',
  },
];

export interface SummaryTableProps {
  readonly data: BacktestEvaluateResponse;
  readonly spreadByHolding: Record<number, BacktestSpreadSummary>;
  readonly expandedHolding: number | null;
  readonly onToggleHolding: (holding: number) => void;
}

export function SummaryTable({
  data,
  spreadByHolding,
  expandedHolding,
  onToggleHolding,
}: SummaryTableProps): React.ReactElement {
  return (
    <Box
      as="table"
      width="100%"
      fontFamily="mono"
      fontSize="11px"
      style={{ borderCollapse: 'collapse' }}
    >
      <SummaryTableHead headers={SUMMARY_HEADERS} />
      <Box as="tbody">
        {data.summary.map((s) => (
          <SummaryRow
            key={s.holding}
            holding={s.holding}
            n={s.n}
            mean={s.mean}
            median={s.median}
            winRate={s.winRate}
            sharpeLike={s.sharpeLike}
            spread={spreadByHolding[s.holding] ?? null}
            expanded={expandedHolding === s.holding}
            onToggle={(): void => {
              onToggleHolding(s.holding);
            }}
          />
        ))}
      </Box>
    </Box>
  );
}

function SummaryTableHead({
  headers,
}: {
  readonly headers: readonly SummaryHeader[];
}): React.ReactElement {
  return (
    <Box as="thead">
      <Box as="tr" color="ink3">
        {headers.map((h) => (
          <Box
            as="td"
            key={h.key}
            px="6px"
            py="3px"
            textAlign={h.align}
            borderBottomWidth="1px"
            borderColor="line"
            title={h.title}
            cursor="help"
          >
            {h.label}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

interface SummaryRowProps {
  readonly holding: number;
  readonly n: number;
  readonly mean: number;
  readonly median: number;
  readonly winRate: number;
  readonly sharpeLike: number;
  readonly spread: BacktestSpreadSummary | null;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}

function SummaryRow(p: SummaryRowProps): React.ReactElement {
  return (
    <Box
      as="tr"
      color="ink"
      cursor="pointer"
      _hover={{ bg: 'panel3' }}
      bg={p.expanded ? 'panel3' : undefined}
      onClick={p.onToggle}
    >
      <Box as="td" px="6px" py="3px">
        {p.expanded ? '▾' : '▸'} {p.holding}d
      </Box>
      <Cell num={p.n} digits={0} />
      <Cell num={p.mean} pct />
      <Cell num={p.median} pct />
      <Cell num={p.winRate} pct />
      {p.spread === null ? (
        <>
          <Cell num={NaN} />
          <Cell num={NaN} />
        </>
      ) : (
        <>
          <Cell num={p.spread.spreadMean} pct />
          <Cell num={p.spread.spreadTStat} digits={2} />
        </>
      )}
      <Cell num={p.sharpeLike} digits={2} />
    </Box>
  );
}
