#!/usr/bin/env node
/**
 * atlas/disagreement.js — disagreement engine.
 *
 * Converts a set of agent directions/scores into consensus, dispersion, minorityRisk
 * and criticalDisagreement. A strong disagreement reduces confidence. Never collapses
 * into a naive average.
 */

'use strict';

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));

/**
 * @param viewpoints { array of { direction: 'bullish'|'bearish'|'neutral'|'unknown', score: 0..100 } }
 * @returns { consensus, dispersion, minorityRisk, criticalDisagreement, agentAgreementScore }
 */
function analyze(viewpoints, opts = {}) {
  const arr = Array.isArray(viewpoints) ? viewpoints : [];
  if (!arr.length) return { consensus: 'unknown', dispersion: 0, minorityRisk: 0, criticalDisagreement: false, agentAgreementScore: 0 };

  let bullish = 0, bearish = 0, neutral = 0, unknown = 0;
  let totalScore = 0;
  const scored = [];

  for (const v of arr) {
    const score = clamp(Number(v.score) || 0);
    scored.push({ direction: v.direction, score });
    totalScore += score;
    if (v.direction === 'bullish') bullish += score;
    else if (v.direction === 'bearish') bearish += score;
    else if (v.direction === 'neutral') neutral += score;
    else unknown += score;
  }

  const total = bullish + bearish + neutral + unknown;
  if (total === 0) return { consensus: 'unknown', dispersion: 0, minorityRisk: 0, criticalDisagreement: false, agentAgreementScore: 0 };

  const bullishShare = bullish / total;
  const bearishShare = bearish / total;

  let consensus;
  if (bullishShare >= 0.6) consensus = 'bullish';
  else if (bearishShare >= 0.6) consensus = 'bearish';
  else if (neutralShareTotal(arr) >= 0.5) consensus = 'neutral';
  else if (bulkDirection(arr) === 'bullish') consensus = 'mildly_bullish';
  else if (bulkDirection(arr) === 'bearish') consensus = 'mildly_bearish';
  else consensus = 'mixed';

  // dispersion — how spread the score-weighted directions are (0..100)
  const pivot = consensus.startsWith('bull') ? bullish : (consensus.startsWith('bear') ? bearish : Math.max(bullish, bearish));
  const opposing = consensus.startsWith('bull') ? bearish : (consensus.startsWith('bear') ? bullish : Math.max(bullish, bearish));
  const dispersion = total > 0 ? clamp((opposing / total) * 100) : 0;

  // minorityRisk — opposite-direction high scorers
  const minority = opposing > 0 && total > 0 ? (opposing / total) * 100 : 0;
  const minorityRisk = clamp(minority);

  // criticalDisagreement — large minority of strong opposite scorers
  const critical = minorityRisk >= 40 && scored.some(s => s.direction !== consensus && s.score >= 70);

  // agentAgreementScore 0..100
  const agreementBase = 100 - dispersion;
  const criticalPenalty = critical ? 15 : 0;
  const agentAgreementScore = clamp(agreementBase - criticalPenalty);

  return {
    consensus: consensus === 'mildly_bullish' ? 'bullish' : (consensus === 'mildly_bearish' ? 'bearish' : consensus),
    dispersion,
    minorityRisk,
    criticalDisagreement: critical,
    agentAgreementScore,
    breakdowns: { bullish: Math.round(bullish), bearish: Math.round(bearish), neutral: Math.round(neutral), unknown: Math.round(unknown), total: Math.round(total) }
  };
}

function neutralShareTotal(arr) {
  let total = 0, neutral = 0;
  for (const v of arr) { const s = clamp(Number(v.score) || 0); total += s; if (v.direction === 'neutral') neutral += s; }
  return total > 0 ? neutral / total : 0;
}

function bulkDirection(arr) {
  let b = 0, be = 0;
  for (const v of arr) { const s = clamp(Number(v.score) || 0); if (v.direction === 'bullish') b += s; else if (v.direction === 'bearish') be += s; }
  return b > be ? 'bullish' : (be > b ? 'bearish' : 'neutral');
}

module.exports = { analyze, clamp };
