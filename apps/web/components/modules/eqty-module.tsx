'use client';

/**
 * Module 07 §workbench — EQTY (Equity workbench).
 * Composes the per-stock detail (chart, sentiment, slack) plus
 * the sector blotter in a Bloomberg-style three-column grid.
 */

import { Grid } from '@chakra-ui/react';
import type { Sentiment } from '@quant/shared';
import { useState } from 'react';

import { useUiStore } from '../../lib/stores/ui.store.js';
import { BlotterPanel } from '../eqty/blotter-panel.js';
import { ChartPanel } from '../eqty/chart-panel.js';
import { EquityDetailPanel } from '../eqty/equity-detail-panel.js';
import { SectorsPanel } from '../eqty/sectors-panel.js';
import { SentimentPanel } from '../eqty/sentiment-panel.js';
import { SlackPushPanel } from '../eqty/slack-push-panel.js';
import { StdoutPanel } from '../eqty/stdout-panel.js';
import { TaskQueuePanel } from '../eqty/task-queue-panel.js';

export function EqtyModule(): React.ReactElement {
  const code = useUiStore((s) => s.focusCode);
  const [sentiment, setSentiment] = useState<Sentiment | null>(null);

  return (
    <Grid
      h="100%"
      templateColumns="280px 1fr 360px"
      templateRows="auto auto auto auto"
      templateAreas={`
        "L CTOP R1"
        "L CMID R2"
        "L CBOT R3"
        "L CBOT R4"
      `}
      gap="1px"
      bg="line"
    >
      <SectorsPanel />
      <EquityDetailPanel code={code} />
      <ChartPanel code={code} />
      <BlotterPanel />
      <SentimentPanel code={code} onResult={setSentiment} />
      <StdoutPanel code={code} sentiment={sentiment} />
      <SlackPushPanel
        code={code}
        sentimentScore={sentiment?.score ?? null}
        theme={sentiment?.theme ?? null}
      />
      <TaskQueuePanel />
    </Grid>
  );
}
