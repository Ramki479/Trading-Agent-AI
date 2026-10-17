#!/usr/bin/env node
/**
 * agents/quant-analyst.js — TradingAgents Quant Analyst (deterministic).
 *
 * Pure statistical analysis over REAL observed trade history + the current
 * candidate's liquidity/volume setup. No I/O, no LLM, no execution authority.
 * Never tunes or modifies the Circuit strategy — it only reads metrics.
 *
 * Output schema:
 *   { agent: 'quant', confidence: 0..100,
 *     expectedDirection: up|flat|down, riskScore: 0..100,
 *     setupQuality: 0..100, historicalSimilarity: 0..100,
 *     reasoning: string[], dataQuality: ok|insufficient_history }
 */
'use strict';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));

function round(n) {
  return Math.round(n * 100) / 100;
}

/** Liquidity/volume quality 0..100 (mirrors the strategy universe bands). */
function setupFromLiquidityVolume(liq, vol) {
  const liqScore = liq >= 100000 ? 100 : liq >= 50000 ? 80 : liq >= 20000 ? 60 : liq >= 10000 ? 40 : liq >= 5000 ? 25 : liq >= 2000 ? 12 : 0;
  const volScore = vol >= 250000 ? 100 : vol >= 100000 ? 80 : vol >= 50000 ? 60 : vol >= 20000 ? 40 : vol >= 10000 ? 25 : 0;
  return Math.round(liqScore * 0.6 + volScore * 0.4);
}

/**
 * @param input { candidate, metrics?, regime?, market?, portfolio? }
 *   candidate: { liquidityUsd, volume24hUsd, score, symbol, mint, recoveryStatus }
 *   metrics:   perfLib.computeMetrics result over closed trades (or empty)
 *   regime:    { regime: bull|consolidation|recovery|dump|UNKNOWN, confidence }
 */
function analyze(input = {}) {
  const cand = input.candidate || {};
  const m = input.metrics || {};
  const regime = input.regime || {};
  const reasoning = [];
  const n = Number(m.n) || 0;
  const insufficient = n < 5;

  // ---- setup quality (liquidity + volume — the trade's own data) -----------
  const setupQuality = setupFromLiquidityVolume(
    Number(cand.liquidityUsd) || 0,
    Number(cand.volume24hUsd) || 0
  );
  reasoning.push(`setup quality ${setupQuality}/100 from liquidity $${Math.round(cand.liquidityUsd || 0).toLocaleString('en-US')} + 24h volume $${Math.round(cand.volume24hUsd || 0).toLocaleString('en-US')}`);

  // ---- historical similarity: same-shape conditions in closed trades --------
  let historicalSimilarity = 0;
  if (insufficient) {
    reasoning.push('insufficient_history — fewer than 5 closed trades; similarity withheld (never fabricated)');
  } else {
    const expect = Number(m.expectancyPct) || 0;
    const wr = Number(m.winRate) || 0;
    // Similarity = how representative today's conditions are of profitable history.
    historicalSimilarity = round(clamp(40 + expect * 2.5 + (wr - 50) * 0.4 + setupQuality * 0.15, 0, 100));
    reasoning.push(`${n} closed trades → win rate ${wr}%, expectancy ${expect}% → similarity ${Math.round(historicalSimilarity)}/100`);
  }

  // ---- risk score (drawdown / streak / regime / setup) ----------------------
  let riskScore = 0;
  const dd = Number(m.maxDrawdownPct) || 0;
  const streak = Number(m.lossStreak) || 0;
  riskScore += clamp(dd * 0.5, 0, 30);                 // drawdown ≤30
  riskScore += clamp(streak * 8, 0, 24);               // streak ≤24
  if (regime.regime === 'dump' || regime.regime === 'recovery') riskScore += 16;
  if (regime.regime === 'UNKNOWN') riskScore += 6;
  riskScore += setupQuality < 40 ? 15 : setupQuality < 65 ? 8 : 0;
  riskScore = Math.round(clamp(riskScore, 0, 100));
  reasoning.push(`risk ${riskScore}/100 (drawdown ${dd}% penalty, loss streak ${streak}, regime ${regime.regime || 'unknown'})`);

  // ---- expected direction ---------------------------------------------------
  let expectedDirection = 'flat';
  if (insufficient) {
    expectedDirection = 'flat';
    reasoning.push('expectedDirection withheld until enough history (flat)');
  } else {
    const expect = Number(m.expectancyPct) || 0;
    const losingWindow = Number(m.lossStreak) >= 3 || regime.regime === 'dump';
    if (expect > 0 && !losingWindow) expectedDirection = 'up';
    else if (expect < 0 || losingWindow) expectedDirection = 'down';
    else expectedDirection = 'flat';
    reasoning.push(`expectancy ${expect}% + regime ${regime.regime || 'unknown'} → ${expectedDirection}`);
  }

  const confidence = insufficient
    ? 0
    : round(clamp(50 + (historicalSimilarity - 50) * 0.4 + (expectedDirection === 'up' ? 8 : expectedDirection === 'down' ? -8 : 0) - riskScore * 0.15, 0, 100));

  return {
    agent: 'quant',
    confidence,
    expectedDirection,
    riskScore,
    setupQuality,
    historicalSimilarity,
    dataQuality: insufficient ? 'insufficient_history' : 'ok',
    reasoning
  };
}

module.exports = { analyze };
