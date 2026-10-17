#!/usr/bin/env node
/**
 * agents/decision-synthesizer.js — TradingAgents Decision Synthesizer.
 *
 * Combines every analyst/researcher output plus the Circuit score, adaptive
 * policy, regime, market health and price-integrity state into ONE research
 * verdict. It produces a SEPARATE researchScore — the Circuit score is never
 * modified. The research recommendation is advisory: in SHADOW/ADVISORY modes
 * it has NO authority over the deterministic Circuit execution.
 *
 * Output schema (spec §13):
 *   { symbol, mint, pairAddress, researchRecommendation: BUY|HOLD|AVOID,
 *     researchConfidence: 0..100, technicalScore, quantScore, sentimentScore,
 *     marketScore, bullScore, bearRisk: 0..100,
 *     consensus: strong_bullish|bullish|mixed|bearish|strong_bearish,
 *     riskLevel: low|medium|high|critical, researchScore: 0..100,
 *     dataQuality, reasons: string[], warnings: string[] }
 */
'use strict';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));

/**
 * Map an analyst direction into a 0..100 score (neutral = 50).
 */
function directionScore(direction, confidence) {
  const c = Number.isFinite(confidence) ? clamp(confidence, 0, 100) : 0;
  if (direction === 'bullish') return Math.round(50 + c / 2);
  if (direction === 'bearish') return Math.round(50 - c / 2);
  return 50; // neutral / unknown → 50 (no invented lean)
}

function directionScoreUpDown(dir, confidence) {
  const c = Number.isFinite(confidence) ? clamp(confidence, 0, 100) : 0;
  if (dir === 'up') return Math.round(50 + c / 2);
  if (dir === 'down') return Math.round(50 - c / 2);
  return 50;
}

/**
 * @param input { symbol, mint, pairAddress, candidate?, technical, quant,
 *                sentiment, market, bull, bear, risk, integrity?,
 *                circuitScore? }
 */
function synthesize(input = {}) {
  const cand = input.candidate || {};
  const t = input.technical || {};
  const q = input.quant || {};
  const s = input.sentiment || {};
  const m = input.market || {};
  const bull = input.bull || {};
  const bear = input.bear || {};
  const risk = input.risk || {};
  const integrity = input.integrity || {};
  const circuitScore = input.circuitScore != null ? input.circuitScore : cand.score;
  const reasons = [];
  const warnings = [];

  // ---- component scores (each 0..100) --------------------------------------
  const technicalScore = directionScore(t.direction, t.confidence);
  const quantScore = directionScoreUpDown(q.expectedDirection, q.confidence);
  const sentimentScore = directionScore(s.direction, s.confidence);
  const marketScore = directionScore(m.regime === 'bull' ? 'bullish' : (m.regime === 'dump' || m.regime === 'recovery' ? 'bearish' : 'neutral'), m.confidence);
  const bullScore = Math.round(clamp(Number(bull.confidence) || 0, 0, 100));
  const bearRisk = Math.round(clamp(Number(bear.riskScore) || 0, 0, 100));

  // ---- researchScore: blend of the agents, discounted by bear risk ---------
  const avg = (technicalScore + quantScore + sentimentScore + marketScore + bullScore) / 5;
  const bearDiscount = bearRisk / 100; // 0..1 — bear reduces at most 35%
  const researchScore = Math.round(clamp(avg * (1 - 0.35 * bearDiscount), 0, 100));

  // ---- data quality (consumes the existing price-integrity verdict) --------
  const dataQuality = integrity && integrity.dataQuality ? integrity.dataQuality : 'ok';
  if (dataQuality !== 'ok') {
    warnings.push('dataQuality=suspicious — research does not override price integrity');
    reasons.push('price-integrity flags this observation (suspicious / PAIR_CHANGED / stale) — research cautious');
  }

  // ---- recommendation --------------------------------------------------------
  let researchRecommendation = 'HOLD';
  if (dataQuality !== 'ok') {
    researchRecommendation = 'HOLD'; // never BUY on a suspicious observation (no new gate: reports only)
    reasons.push('recommendation capped at HOLD while price integrity is not ok');
  } else if (bearRisk >= 75) {
    researchRecommendation = 'AVOID';
    reasons.push(`bear risk ${bearRisk}/100 is critical — AVOID`);
  } else if (researchScore >= 70) {
    researchRecommendation = 'BUY';
    reasons.push(`research score ${researchScore}/100 supports a dip-reversal BUY`);
  } else if (researchScore < 45) {
    researchRecommendation = 'AVOID';
    reasons.push(`research score ${researchScore}/100 is too weak — AVOID`);
  } else {
    researchRecommendation = 'HOLD';
    reasons.push(`research score ${researchScore}/100 — HOLD until evidence strengthens`);
  }

  // ---- consensus label --------------------------------------------------------
  let consensus = 'mixed';
  if (dataQuality !== 'ok') consensus = 'mixed';
  else if (researchScore >= 80 && bearRisk < 35) consensus = 'strong_bullish';
  else if (researchScore >= 65) consensus = 'bullish';
  else if (researchScore <= 20) consensus = 'strong_bearish';
  else if (researchScore <= 40) consensus = 'bearish';
  else consensus = 'mixed';

  reasons.push(`research ${researchScore}/100 vs Circuit score ${circuitScore}/100 (kept separate)`);

  return {
    symbol: input.symbol || cand.symbol || null,
    mint: input.mint || cand.mint || null,
    pairAddress: input.pairAddress || cand.pairAddress || null,
    researchRecommendation,
    researchConfidence: researchScore,
    technicalScore,
    quantScore,
    sentimentScore,
    marketScore,
    bullScore,
    bearRisk,
    riskLevel: (risk && risk.riskLevel) || 'medium',
    riskScore: (risk && risk.riskScore) || 0,
    researchScore,
    consensus,
    dataQuality,
    circuitScore: circuitScore != null ? circuitScore : null,
    reasons,
    warnings
  };
}

module.exports = { synthesize };
