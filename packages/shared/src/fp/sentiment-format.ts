/**
 * Terminal-style formatters for the structured Sentiment / MarketSentiment.
 *
 * Returns a `string[]` of lines so FE renderers (line-numbered stdout
 * panes), IM cards, and the terminal pager can each compose the same
 * content into their own chrome. Pure: no IO, no globals. The "full"
 * representation per CLAUDE.md is `lines.join('\n')`; "brief" is the
 * dedicated `sentiment.brief` / `market.brief` field rendered above.
 */

import type {
  CompetitiveLandscape,
  Insight,
  MarketSentiment,
  PriceSignal,
  ProductInfo,
  ResearchTarget,
  Sentiment,
  ThemeClusterView,
  ThemeTag,
} from '../types/eqty.js';

const DIRECTION_SYM: Readonly<Record<Insight['direction'], string>> = {
  positive: '+',
  negative: '-',
  neutral: '·',
};

const PRICE_CHANGE_SYM: Readonly<Record<PriceSignal['change'], string>> = {
  price_up: '↑',
  price_down: '↓',
  shortage: '!!',
  destock: '↘',
  stable: '=',
};

export function sentimentLines(s: Sentiment): readonly string[] {
  const out: string[] = [];
  out.push(`▎ score   ${s.score.toFixed(2)}`);
  if (s.brief.length > 0) {
    out.push('▎ brief', `  ${s.brief}`);
  }
  pushInsights(out, 'drivers', s.coreDrivers);
  pushThemes(out, s.hotThemes);
  pushProducts(out, s.coreProducts);
  pushSignals(out, s.priceSignals);
  pushInsights(out, 'm&a', s.mAndA);
  pushInsights(out, 'supply', s.supplyDemand);
  pushResearch(out, s.researchTargets);
  pushCompetitive(out, s.competitiveLandscape);
  if (s.coverageGaps.length > 0) {
    out.push(`▎ gaps    ${s.coverageGaps.join(', ')}`);
  }
  if (s.caveats.length > 0) {
    out.push('▎ caveats');
    for (const c of s.caveats) out.push(`  ! ${c}`);
  }
  return out;
}

export function marketSentimentLines(m: MarketSentiment): readonly string[] {
  const out: string[] = [];
  out.push(`▎ members ${String(m.codes.length)}  themes ${String(m.themeClusters.length)}`);
  if (m.brief.length > 0) {
    out.push('▎ brief', `  ${m.brief}`);
  }
  if (m.themeClusters.length > 0) {
    out.push('▎ themes');
    for (const c of m.themeClusters) {
      out.push(formatCluster(c));
      if (c.summary.length > 0) out.push(`    ${c.summary}`);
    }
  }
  if (m.styleSignals.length > 0) {
    out.push('▎ style');
    for (const s of m.styleSignals) {
      out.push(`  · ${s.name} [conf=${s.confidence.toFixed(2)}] ${s.rationale}`);
    }
  }
  if (m.industryTrends.length > 0) {
    out.push('▎ industry');
    for (const t of m.industryTrends) {
      out.push(`  · ${t.industry} [${t.direction}] ${t.summary}`);
      if (t.drivers.length > 0) out.push(`      + ${t.drivers.join(' / ')}`);
      if (t.risks.length > 0) out.push(`      - ${t.risks.join(' / ')}`);
    }
  }
  if (m.caveats.length > 0) {
    out.push('▎ caveats');
    for (const c of m.caveats) out.push(`  ! ${c}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// section helpers
// ---------------------------------------------------------------------------

function pushInsights(out: string[], label: string, items: readonly Insight[]): void {
  if (items.length === 0) return;
  out.push(`▎ ${label} (${String(items.length)})`);
  for (const i of items) {
    const sym = DIRECTION_SYM[i.direction];
    const rumor = i.isRumor ? ' [rumor]' : '';
    out.push(`  ${sym} ${i.summary} [${i.confidence.toFixed(2)}]${rumor}`);
  }
}

function pushThemes(out: string[], items: readonly ThemeTag[]): void {
  if (items.length === 0) return;
  out.push(`▎ themes (${String(items.length)})`);
  for (const t of items) {
    const tail = t.rationale.length > 0 ? `  ${t.rationale}` : '';
    out.push(`  · ${t.label} [r=${t.relevance.toFixed(2)}]${tail}`);
  }
}

function pushProducts(out: string[], items: readonly ProductInfo[]): void {
  if (items.length === 0) return;
  out.push(`▎ products (${String(items.length)})`);
  for (const p of items) {
    const share = p.revenueSharePct === null ? '' : ` [${p.revenueSharePct.toFixed(0)}%]`;
    const note = p.note === null ? '' : `  ${p.note}`;
    out.push(`  · ${p.name}${share}${note}`);
  }
}

function pushSignals(out: string[], items: readonly PriceSignal[]): void {
  if (items.length === 0) return;
  out.push(`▎ signals (${String(items.length)})`);
  for (const s of items) {
    const mag = s.magnitude === null ? '' : ` ${s.magnitude}`;
    out.push(`  · ${s.product} ${PRICE_CHANGE_SYM[s.change]} ${s.horizon}${mag}`);
  }
}

function pushResearch(out: string[], items: readonly ResearchTarget[]): void {
  if (items.length === 0) return;
  out.push(`▎ research (${String(items.length)})`);
  for (const r of items) {
    const parts: string[] = [r.broker];
    if (r.rating !== null) parts.push(r.rating);
    if (r.targetPrice !== null) parts.push(`target=${r.targetPrice.toFixed(2)}`);
    if (r.targetUpsidePct !== null) parts.push(`${r.targetUpsidePct.toFixed(1)}%`);
    if (r.horizonMonths !== null) parts.push(`${String(r.horizonMonths)}m`);
    if (r.reportDate !== null) parts.push(r.reportDate);
    out.push(`  · ${parts.join(' · ')}`);
  }
}

function pushCompetitive(out: string[], c: CompetitiveLandscape | null): void {
  if (c === null) return;
  const share = c.marketSharePct === null ? '' : `  share=${c.marketSharePct.toFixed(1)}%`;
  out.push(`▎ competitive [${c.marketPosition}]${share}`);
  if (c.summary.length > 0) out.push(`  ${c.summary}`);
  if (c.moats.length > 0) out.push(`  moat: ${c.moats.join(' / ')}`);
  if (c.risks.length > 0) out.push(`  risk: ${c.risks.join(' / ')}`);
  for (const cp of c.competitors) {
    out.push(`  · ${cp.name} [${cp.relation} · ${cp.threatLevel}] ${cp.note}`);
  }
}

function formatCluster(c: ThemeClusterView): string {
  return `  · ${c.label} [${String(c.memberCodes.length)}m heat=${c.heatScore.toFixed(2)} ${c.trend}]`;
}
