/**
 * Stable scope identifiers for every prompt the codebase ships.
 *
 * Direct callers should import the typed builder functions (with their
 * specific argument shapes) — the registry exists for callers that need
 * dynamic dispatch by string scope (eval harness, future admin UI).
 */

import { buildAgentSystemPrompt } from './agent-system.prompt.js';
import { buildLedgerSystemPrompt, buildLedgerUserPrompt } from './ledger-analyze.prompt.js';
import { buildNlToDslSystemPrompt } from './screen-nl-to-dsl.prompt.js';
import { buildSectorSummaryPrompt } from './sector-summary.prompt.js';
import {
  buildSentimentClusterSystem,
  buildSentimentClusterUser,
  buildSentimentMarketSynthSystem,
  buildSentimentMarketSynthUser,
  buildSentimentSystem,
  buildSentimentUser,
} from './sentiment.prompt.js';
import { buildTaSystemPrompt, buildTaUserPrompt } from './ta-analyze.prompt.js';

export const PromptScope = {
  ScreenNlToDsl: 'screen.nlToDsl',
  Sentiment: 'sentiment.singleStock',
  SentimentUser: 'sentiment.singleStock.user',
  SentimentCluster: 'sentiment.cluster',
  SentimentClusterUser: 'sentiment.cluster.user',
  SentimentMarketSynth: 'sentiment.marketSynth',
  SentimentMarketSynthUser: 'sentiment.marketSynth.user',
  TaAnalyzeSystem: 'ta.analyze.system',
  TaAnalyzeUser: 'ta.analyze.user',
  SectorSummary: 'ta.sectorSummary',
  LedgerAnalyzeSystem: 'ledger.analyze.system',
  LedgerAnalyzeUser: 'ledger.analyze.user',
  AgentSystem: 'agent.system',
} as const;

export type PromptScopeKey = (typeof PromptScope)[keyof typeof PromptScope];

/**
 * Untyped registry — dispatching by string scope, callers cast the
 * returned function to the right signature. Prefer importing the typed
 * builder directly when possible.
 */
export const promptRegistry = {
  [PromptScope.ScreenNlToDsl]: buildNlToDslSystemPrompt,
  [PromptScope.Sentiment]: buildSentimentSystem,
  [PromptScope.SentimentUser]: buildSentimentUser,
  [PromptScope.SentimentCluster]: buildSentimentClusterSystem,
  [PromptScope.SentimentClusterUser]: buildSentimentClusterUser,
  [PromptScope.SentimentMarketSynth]: buildSentimentMarketSynthSystem,
  [PromptScope.SentimentMarketSynthUser]: buildSentimentMarketSynthUser,
  [PromptScope.TaAnalyzeSystem]: buildTaSystemPrompt,
  [PromptScope.TaAnalyzeUser]: buildTaUserPrompt,
  [PromptScope.SectorSummary]: buildSectorSummaryPrompt,
  [PromptScope.LedgerAnalyzeSystem]: buildLedgerSystemPrompt,
  [PromptScope.LedgerAnalyzeUser]: buildLedgerUserPrompt,
  [PromptScope.AgentSystem]: buildAgentSystemPrompt,
} as const;
