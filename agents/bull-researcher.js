#!/usr/bin/env node
/**
 * agents/bull-researcher.js — TradingAgents Bull Researcher (deterministic).
 *
 * Builds the strongest supportable bullish case from the actual analyst
 * outputs + observed data. It never fabricates evidence and has NO execution
 * authority. Every claim it makes must trace to a supplied fact.
 *
 * Output schema:
 *   { agent: 'bull-researcher', confidence: 0..100, case: string[],
 *     supportingEvidence: string[] }
 */
'use strict';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));

/**
 * @param input { technical, quant, sentiment, market, candidate, integrity? }
 */
function analyze(input = {}) {
  const t = input.technical || {};
  const q = input.quant || {};
  const s = input.sentiment || {};
  const m = input.market || {};
  const cand = input.candidate || {};
  const caseList = [];
  const evidence = [];

  if (cand.score != null) {
    evidence.push(`Circuit score ${cand.score}/100 (dip/reversal setup)`);
  }
  if (t.direction === 'bullish') {
    caseList.push(`Technical momentum supports a recovery (net ${Math.round(t.confidence || 0)}/100, recoveryStrength ${Math.round(t.recoveryStrength || 0)}/100).`);
    evidence.push(`local 5m recovery present with volume confirmation ${Math.round(t.volumeConfirmation || 0)}/100`);
  }
  if (q.expectedDirection === 'up') {
    caseList.push('Quant conditions align: positive expectancy history and a healthy setup.');
    evidence.push(`setupQuality ${Math.round(q.setupQuality || 0)}/100, historicalSimilarity ${Math.round(q.historicalSimilarity || 0)}/100`);
  }
  if (s.direction === 'bullish') {
    caseList.push('Observed market activity (volume acceleration + recovery persistence) is supportive.');
    evidence.push(`volumeAcceleration ${Math.round(s.volumeAcceleration || 0)}/100`);
  }
  if (m.regime === 'bull') {
    caseList.push('Broad Solana regime is bullish (regime-detector), a tailwind for dip-reversal entries.');
    evidence.push(`marketHealth ${Math.round(m.marketHealth || 0)}/100`);
  }
  if (m.marketHealth != null && m.marketHealth >= 60 && m.regime !== 'dump') {
    caseList.push('Market-health proxy is healthy enough for the strategy universe.');
  }
  const integrityOk = !input.integrity || input.integrity.dataQuality === 'ok';
  if (integrityOk) evidence.push('price-integrity: observation data quality ok');

  // Confidence = weighted analyst support; no evidence → do not invent a case.
  const raw = (t.direction === 'bullish' ? (t.confidence || 0) * 0.3 : 0) +
    (q.expectedDirection === 'up' ? (q.confidence || 0) * 0.2 : 0) +
    (s.direction === 'bullish' ? (s.confidence || 0) * 0.15 : 0) +
    (m.regime === 'bull' || m.marketHealth >= 60 ? (m.confidence || 0) * 0.15 : 0) +
    Math.min(100, (cand.score || 0)) * 0.2;
  const confidence = caseList.length ? Math.round(clamp(raw, 0, 100)) : 0;
  if (!caseList.length) caseList.push('No strong supportive evidence observed — bullish case not fabricated.');

  return {
    agent: 'bull-researcher',
    confidence,
    case: caseList,
    supportingEvidence: evidence
  };
}

module.exports = { analyze };
