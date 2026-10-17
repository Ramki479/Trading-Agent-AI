#!/usr/bin/env node
/**
 * atlas/agents/liquidity.js — ATLAS Liquidity Agent.
 *
 * Analyzes liquidity depth, volume/liquidity ratio, spread proxy, sudden liquidity
 * changes, concentration, and exitability. Returns liquidityScore 0..100 and
 * liquidityRisk LOW/MEDIUM/HIGH/EXTREME.
 */

'use strict';

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));

const LIQUIDITY_RISK = ['LOW', 'MEDIUM', 'HIGH', 'EXTREME'];

function analyze(input = {}) {
  const cand = input.candidate || {};
  const integrity = input.integrity || {};
  const dq = integrity.dataQuality === 'suspicious' || integrity.dataQuality === 'fail' ? 0 : 100;

  const liquidityUsd = Number.isFinite(cand.liquidityUsd) ? cand.liquidityUsd : 0;
  const volume24hUsd = Number.isFinite(cand.volume24hUsd) ? cand.volume24hUsd : 0;
  const volumeUsd = Number.isFinite(cand.volumeUsd) ? cand.volumeUsd : volume24hUsd;
  const priceUsd = Number.isFinite(cand.priceUsd) ? cand.priceUsd : (Number.isFinite(cand.priceSol) && input.solPriceUsd ? cand.priceSol * input.solPriceUsd : 0.00001);

  const solPriceUsd = Number.isFinite(input.solPriceUsd) ? input.solPriceUsd : 150;
  const tradeSizeSol = input.tradeSizeSol || 0.05;
  const estimatedTradeValueUsd = tradeSizeSol * solPriceUsd;

  let direction = 'neutral';
  let reason = 'insufficient data';
  let confidence = 0;
  let score = 0;
  let liquidityScore = 0;
  let liquidityRisk = 'UNKNOWN';
  let exitability = 'UNKNOWN';
  let liqRatio = 0, depthVsTrade = 0, spreadProxy = 0, volumeLiquidityRatio = 0;

  if (dq === 0) {
    direction = 'unknown';
    reason = 'price-integrity flagged data as invalid/quarantined';
    liquidityRisk = 'UNKNOWN';
    exitability = 'UNKNOWN';
  } else if (liquidityUsd <= 0 && volume24hUsd <= 0) {
    direction = 'unknown';
    reason = 'no liquidity/volume data';
    liquidityRisk = 'UNKNOWN';
    exitability = 'UNKNOWN';
  } else {
    liqRatio = liquidityUsd > 0 ? volume24hUsd / liquidityUsd : 0;
    depthVsTrade = liquidityUsd > 0 ? Math.min(1, liquidityUsd / Math.max(estimatedTradeValueUsd, 1)) : 0;
    spreadProxy = liquidityUsd > 0 ? Math.max(0, 1 - Math.min(1, estimatedTradeValueUsd / liquidityUsd)) : 0;
    volumeLiquidityRatio = computeVolumeLiquidityRatio(volumeUsd, liquidityUsd);

    liquidityScore = computeLiquidityScore(liquidityUsd, volume24hUsd, liqRatio, depthVsTrade, spreadProxy);
    const riskLevel = computeLiquidityRisk(liquidityUsd, depthVsTrade, spreadProxy);
    liquidityRisk = riskLevel;
    exitability = computeExitability(liquidityUsd, depthVsTrade, spreadProxy);

    if (liquidityRisk === 'EXTREME') {
      direction = 'bearish';
      reason = 'extreme liquidity risk — exits may fail, unreliable';
      confidence = clamp(20);
    } else if (liquidityRisk === 'HIGH') {
      direction = 'bearish';
      reason = 'high liquidity risk — exits may be unreliable';
      confidence = clamp(30);
    } else if (liquidityRisk === 'MEDIUM') {
      direction = 'neutral';
      reason = 'moderate liquidity — adequate but not deep';
      confidence = clamp(35);
    } else {
      direction = 'neutral';
      reason = 'sufficient liquidity depth';
      confidence = clamp(40 + Math.min(40, depthVsTrade * 100));
    }
    score = clamp(Math.round(confidence));
    confidence = clamp(confidence);
  }

  const evidence = [];
  if (dq > 0 && liquidityUsd > 0) {
    evidence.push({ claim: 'liquidity depth', value: '$' + Math.round(liquidityUsd).toLocaleString(), source: 'candidate_metadata', confidence: clamp(70 + Math.min(30, depthVsTrade * 30)), timestamp: Date.now() });
    evidence.push({ claim: 'volume/liquidity ratio', value: volumeLiquidityRatio.toFixed(2), source: 'candidate_metadata', confidence: clamp(50 + volumeLiquidityRatio * 30), timestamp: Date.now() });
    evidence.push({ claim: 'liquidity depth vs trade size', value: depthVsTrade.toFixed(2) + ' (liquidity/trade ratio)', source: 'atlas_liquidity_agent', confidence: clamp(60 + depthVsTrade * 30), timestamp: Date.now() });
    evidence.push({ claim: 'spread proxy', value: spreadProxy.toFixed(2), source: 'atlas_liquidity_agent', confidence: clamp(50 + spreadProxy * 30), timestamp: Date.now() });
    evidence.push({ claim: 'liquidity risk', value: liquidityRisk, source: 'atlas_liquidity_agent', confidence: clamp(55), timestamp: Date.now() });
    evidence.push({ claim: 'exitability', value: exitability, source: 'atlas_liquidity_agent', confidence: clamp(55 + (exitability === 'HIGH' ? 20 : exitability === 'MEDIUM' ? 10 : 0)), timestamp: Date.now() });
  }

  const risks = [];
  if (liquidityRisk === 'HIGH' || liquidityRisk === 'EXTREME') risks.push('low_liquidity_exit_risk');
  if (spreadProxy < 0.5) risks.push('wide_effective_spread');
  if (depthVsTrade < 0.5) risks.push('shallow_depth_relative_to_trade');
  if (dq === 0) risks.push('data_integrity_failed');

  const invalidatingConditions = [];
  if (liquidityRisk === 'EXTREME') invalidatingConditions.push('extreme liquidity risk — trade exits may fail');
  if (depthVsTrade < 0.3) invalidatingConditions.push('liquidity too shallow relative to trade size');

  return {
    agent: 'liquidity',
    candidate: cand.symbol || '',
    timestamp: Date.now(),
    direction,
    confidence: Math.round(clamp(confidence)),
    score: Math.round(score),
    timeHorizon: '15m',
    thesis: reason,
    evidence,
    risks,
    invalidatingConditions,
    prediction: predictionObj(direction, score, liquidityScore),
    dataQuality: dq > 0 ? 'ok' : integrity.dataQuality || 'ok',
    liquidityScore: Math.round(liquidityScore),
    liquidityRisk,
    exitability,
    depthVsTrade: Math.round(depthVsTrade * 100) / 100,
    spreadProxy: Math.round(spreadProxy * 100) / 100
  };

  function computeVolumeLiquidityRatio(volume, liquidity) {
    if (liquidity <= 0) return 0;
    return clamp(volume / liquidity, 0, 10);
  }

  function computeLiquidityScore(liquidity, volume, ratio, depthVsTrade, spread) {
    let s = 0;
    s += clamp(liquidity / 1000000) * 30;
    s += clamp(volume / 2000000) * 15;
    s += clamp(ratio) * 10;
    s += clamp(depthVsTrade) * 25;
    s += clamp(spread) * 20;
    return clamp(Math.round(s));
  }

  function computeLiquidityRisk(liquidityUsd, depthVsTrade, spreadProxy) {
    if (liquidityUsd <= 0) return 'EXTREME';
    if (depthVsTrade < 0.2) return 'EXTREME';
    if (depthVsTrade < 0.4) return 'HIGH';
    if (depthVsTrade < 0.7 && spreadProxy < 0.6) return 'MEDIUM';
    if (spreadProxy < 0.4) return 'MEDIUM';
    return 'LOW';
  }

  function computeExitability(liquidityUsd, depthVsTrade, spreadProxy) {
    if (liquidityUsd <= 0) return 'LOW';
    if (depthVsTrade >= 1) return 'HIGH';
    if (depthVsTrade >= 0.5 && spreadProxy >= 0.6) return 'HIGH';
    if (depthVsTrade >= 0.3) return 'MEDIUM';
    return 'LOW';
  }

  function predictionObj(direction, score, liqScore) {
    if (direction === 'unknown') return { expectedMovePct: 0, probabilityUp: 0, probabilityDown: 0 };
    const base = clamp(score / 100);
    const up = direction === 'bullish' ? base : (direction === 'bearish' ? 1 - base : 0.5);
    const down = direction === 'bearish' ? base : (direction === 'bullish' ? 1 - base : 0.5);
    const liquidityBias = liqScore >= 70 ? 0 : (liqScore >= 40 ? -5 : -15);
    const expected = (direction === 'bullish' ? 1 : -1) * clamp(score / 15) + liquidityBias;
    return {
      expectedMovePct: Math.round(clamp(expected, -50, 50)),
      probabilityUp: clamp(up + (direction === 'bullish' ? 0 : -10)),
      probabilityDown: clamp(down + (direction === 'bearish' ? 0 : -10))
    };
  }
}

module.exports = { analyze, LIQUIDITY_RISK };
