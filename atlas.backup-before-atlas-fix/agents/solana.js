#!/usr/bin/env node
/**
 * atlas/agents/solana.js — ATLAS Solana Ecosystem Agent.
 *
 * Analyzes broader Solana conditions where reliable data exists:
 *   - SOL trend
 *   - SOL volatility
 *   - ecosystem liquidity
 *   - major ecosystem movements
 *   - network conditions if relevant
 *   - broad risk appetite
 *
 * Does NOT invent blockchain statistics. Missing data must remain missing.
 */

'use strict';

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));

function analyze(input = {}) {
  const market = input.market || {};
  const integrity = input.integrity || {};
  const cand = input.candidate || {};
  const dq = integrity.dataQuality === 'suspicious' || integrity.dataQuality === 'fail' ? 0 : 100;

  const solPriceUsd = Number.isFinite(market.solPriceUsd) ? market.solPriceUsd : null;
  const solMomentumPct = Number.isFinite(market.solMomentumPct) ? market.solMomentumPct : null;
  const solVolatility = Number.isFinite(market.solVolatilityPct) ? market.solVolatilityPct : null;
  const healthScore = Number.isFinite(market.healthScore) ? market.healthScore : null;
  const healthStatus = market.healthStatus || null;
  const healthGate = market.healthGate === true;
  const regime = market.regime || null;
  const liquidityConditions = market.liquidityConditions || null;
  const ecosystemMovement = market.ecosystemMovement || null;
  const riskAppetite = market.riskAppetite || null;

  let direction = 'neutral';
  let reason = 'insufficient data';
  let confidence = 0;
  let score = 0;
  let status = 'NO_DATA';

  const evidence = [];
  const risks = [];
  const invalidatingConditions = [];

  if (dq === 0) {
    direction = 'unknown';
    reason = 'price-integrity flagged data as invalid/quarantined';
    status = 'NO_DATA';
  } else if (!Number.isFinite(solPriceUsd) || solPriceUsd <= 0) {
    direction = 'neutral';
    reason = 'no SOL price data available';
    status = 'NO_DATA';
  } else {
    status = 'PARTIAL';
    let solTrendConf = 0;
    let solTrendDir = 'neutral';

    if (Number.isFinite(solMomentumPct) && solMomentumPct > 3) {
      solTrendDir = 'bullish';
      solTrendConf = clamp(30 + Math.min(70, solMomentumPct * 3));
    } else if (Number.isFinite(solMomentumPct) && solMomentumPct < -3) {
      solTrendDir = 'bearish';
      solTrendConf = clamp(30 + Math.min(70, -solMomentumPct * 3));
    } else {
      solTrendConf = clamp(20 + Math.min(40, Math.abs(solMomentumPct || 0) * 5));
    }

    if (solTrendDir === 'bullish') {
      direction = 'bullish';
      reason = 'SOL trending up (' + solMomentumPct.toFixed(1) + '%) — positive ecosystem backdrop';
      confidence = clamp(solTrendConf + (healthGate ? -10 : 0));
    } else if (solTrendDir === 'bearish') {
      direction = 'bearish';
      reason = 'SOL trending down (' + solMomentumPct.toFixed(1) + '%) — negative ecosystem backdrop';
      confidence = clamp(solTrendConf);
    } else {
      direction = 'neutral';
      reason = 'SOL momentum ambiguous (' + (solMomentumPct != null ? solMomentumPct.toFixed(1) : 'n/a') + '%)';
      confidence = clamp(solTrendConf);
    }

    score = clamp(Math.round(confidence));
    confidence = clamp(confidence);

    // evidence
    evidence.push({ claim: 'SOL price', value: '$' + (solPriceUsd ? solPriceUsd.toFixed(2) : 'n/a'), source: 'market_context', confidence: clamp(80), timestamp: Date.now(), sourceDetail: 'sol_price' });
    evidence.push({ claim: 'SOL momentum', value: (solMomentumPct != null ? solMomentumPct.toFixed(1) : 'n/a') + '%', source: 'market_context', confidence: clamp(solTrendConf), timestamp: Date.now(), sourceDetail: 'sol_momentum' });
    if (Number.isFinite(solVolatility) && solVolatility > 0) {
      evidence.push({ claim: 'SOL volatility', value: solVolatility.toFixed(1) + '%', source: 'market_context', confidence: clamp(45 + Math.min(100, (100 - solVolatility) * 0.3)), timestamp: Date.now(), sourceDetail: 'sol_volatility' });
      if (solVolatility >= 80) risks.push('high_sol_volatility');
      else if (solVolatility >= 60) risks.push('elevated_sol_volatility');
    }
    if (Number.isFinite(healthScore)) {
      evidence.push({ claim: 'market health score', value: healthScore.toFixed(0), source: 'market_health', confidence: clamp(50 + healthScore * 0.4), timestamp: Date.now(), sourceDetail: 'market_health_score' });
      if (healthGate) {
        evidence.push({ claim: 'market health gate', value: 'ACTIVE', source: 'market_health', confidence: clamp(70), timestamp: Date.now(), sourceDetail: 'health_gate' });
        risks.push('market_health_gate_active');
      }
      if (healthStatus) evidence.push({ claim: 'health status', value: healthStatus, source: 'market_health', confidence: clamp(50), timestamp: Date.now(), sourceDetail: 'health_status' });
    }
    if (regime) evidence.push({ claim: 'broad regime', value: regime, source: 'market_context', confidence: clamp(40 + Math.min(60, healthScore != null ? healthScore * 0.2 : 20)), timestamp: Date.now(), sourceDetail: 'broad_regime' });
    if (liquidityConditions && typeof liquidityConditions === 'string') evidence.push({ claim: 'liquidity conditions', value: liquidityConditions, source: 'market_context', confidence: clamp(30), timestamp: Date.now(), sourceDetail: 'liquidity_conditions' });
    if (ecosystemMovement && typeof ecosystemMovement === 'string') evidence.push({ claim: 'ecosystem movement', value: ecosystemMovement, source: 'market_context', confidence: clamp(30), timestamp: Date.now(), sourceDetail: 'ecosystem_movement' });
    if (riskAppetite && typeof riskAppetite === 'string') evidence.push({ claim: 'risk appetite', value: riskAppetite, source: 'market_context', confidence: clamp(25), timestamp: Date.now(), sourceDetail: 'risk_appetite' });
  }

  if (dq === 0) risks.push('data_integrity_failed');

  return {
    agent: 'solana',
    candidate: cand.symbol || '',
    timestamp: Date.now(),
    direction,
    confidence: Math.round(clamp(confidence)),
    score: Math.round(score),
    timeHorizon: '1h',
    thesis: reason,
    evidence,
    risks,
    invalidatingConditions,
    prediction: predictionObj(direction, score),
    dataQuality: dq > 0 ? 'ok' : integrity.dataQuality || 'ok',
    status
  };

  function predictionObj(direction, score) {
    if (direction === 'unknown' || direction === 'neutral') return { expectedMovePct: 0, probabilityUp: 0.5, probabilityDown: 0.5 };
    const base = clamp(score / 100);
    const up = direction === 'bullish' ? base : (direction === 'bearish' ? 1 - base : 0.5);
    const down = direction === 'bearish' ? base : (direction === 'bullish' ? 1 - base : 0.5);
    const expected = (direction === 'bullish' ? 1 : -1) * clamp(score / 20);
    return {
      expectedMovePct: Math.round(clamp(expected, -50, 50)),
      probabilityUp: clamp(up),
      probabilityDown: clamp(down)
    };
  }
}

module.exports = { analyze };
