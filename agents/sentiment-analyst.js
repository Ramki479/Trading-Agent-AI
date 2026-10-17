#!/usr/bin/env node
/**
 * agents/sentiment-analyst.js — TradingAgents Sentiment Analyst (deterministic).
 *
 * Sentiment is derived ONLY from actually-observed market activity — there is
 * no news/social API in this agent and this module NEVER fabricates news,
 * social sentiment, announcements or statistics. When no reliable signal
 * exists it reports direction "unknown" / confidence 0.
 *
 * Available activity signals (real):
 *   - local 5m recovery persistence (samples)
 *   - 24h volume vs the candidate universe (relative activity)
 *   - liquidity conditions
 *   - SOL market condition (regime / health — supplied, not invented)
 *
 * Output schema:
 *   { agent: 'sentiment', direction: bullish|bearish|unknown, confidence: 0..100,
 *     volumeAcceleration: 0..100, reasoning: string[], dataQuality }
 */
'use strict';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));

function round(n) {
  return Math.round(n * 100) / 100;
}

/**
 * @param input { candidate, history?, market?, universe? }
 *   candidate: { recoveryPct, recoveryStatus, recoverySamples, liquidityUsd,
 *                volume24hUsd, change1hPct }
 *   history:   { samples, warming }
 *   market:    { regime, healthScore, solMomentum? }
 *   universe:  { candidates, avgVolumeUsd? } — relative activity context
 */
function analyze(input = {}) {
  const cand = input.candidate || {};
  const history = input.history || {};
  const market = input.market || {};
  const universe = input.universe || {};
  const reasoning = [];

  // No fabricated sentiment, ever.
  reasoning.push('no news/social/announcement source — sentiment uses observed market activity only');

  const warming = history.warming || cand.recoveryStatus === 'warming';
  const samples = Number(cand.recoverySamples) || (history.samples ? history.samples.length : 0);

  // ---- volume acceleration proxy (real 24h volume vs universe average) -----
  let volumeAcceleration = 0;
  const vol = Number(cand.volume24hUsd) || 0;
  const liq = Number(cand.liquidityUsd) || 0;
  const univAvg = Number(universe.avgVolumeUsd) || 0;
  if (vol > 0 && liq > 0) {
    const turnover = vol / liq;
    let rel = 1;
    if (univAvg > 0) rel = vol / univAvg;
    volumeAcceleration = round(clamp(((turnover / 3) * 50) + ((rel / 2) * 50), 0, 100));
    reasoning.push(`24h volume $${Math.round(vol).toLocaleString('en-US')} = ${turnover.toFixed(2)}x liquidity, ${rel.toFixed(2)}x universe average → volumeAcceleration ${Math.round(volumeAcceleration)}/100`);
  } else {
    reasoning.push('no volume/liquidity data — volume acceleration unknown');
  }

  // ---- derive a direction only from persistent, real signals ---------------
  let direction = 'unknown';
  let confidence = 0;
  if (warming || samples < 8) {
    reasoning.push(`insufficient_history (${samples} samples, warming=${warming}) — sentiment unknown`);
  } else if (volumeAcceleration === 0) {
    reasoning.push('insufficient market activity data — sentiment unknown');
  } else {
    const recovering = Number.isFinite(cand.recoveryPct) && cand.recoveryPct >= 0.5;
    const marketTailwind = market.regime === 'bull' || (market.healthScore != null && market.healthScore >= 60);
    const positive = recovering && volumeAcceleration >= 55 && marketTailwind;
    const negative = !recovering && volumeAcceleration >= 70 && market.regime === 'dump';
    if (positive) {
      direction = 'bullish';
      confidence = round(clamp(40 + volumeAcceleration * 0.35 + (recovering ? 15 : 0), 0, 100));
    } else if (negative) {
      direction = 'bearish';
      confidence = round(clamp(30 + volumeAcceleration * 0.3, 0, 100));
    } else {
      reasoning.push('activity signals mixed/weak — sentiment unknown (not fabricated)');
    }
    reasoning.push(`recovery persistence=${recovering ? 'yes' : 'no'}, market tailwind=${marketTailwind ? 'yes' : 'no'} → ${direction}`);
  }

  return {
    agent: 'sentiment',
    direction,
    confidence: Math.round(confidence),
    volumeAcceleration: Math.round(volumeAcceleration),
    dataQuality: warming || samples < 8 ? 'insufficient_history' : 'ok',
    reasoning
  };
}

module.exports = { analyze };
