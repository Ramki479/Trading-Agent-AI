#!/usr/bin/env node
/**
 * atlas/agents/volatility.js — ATLAS Volatility Agent.
 *
 * Analyzes realized volatility, expansion/compression, abnormal moves, and short-term
 * expected range. High volatility reduces confidence — it does NOT automatically create
 * a trade.
 */

'use strict';

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));

function analyze(input = {}) {
  const cand = input.candidate || {};
  const hist = input.history && input.history.samples ? input.history.samples : [];
  const integrity = input.integrity || {};
  const dq = integrity.dataQuality === 'suspicious' || integrity.dataQuality === 'fail' ? 0 : 100;

  const series = Array.isArray(hist) ? hist : [];
  const recoveryPct = Number.isFinite(cand.recoveryPct) ? cand.recoveryPct : null;
  const change1hPct = Number.isFinite(cand.change1hPct) ? cand.change1hPct : null;

  let direction = 'neutral';
  let reason = 'insufficient data';
  let confidence = 0;
  let score = 0;
  let volClass = 'UNKNOWN';
  let realizedVol = 0;
  let expectedRangePct = 0;
  let expansion = 0;

  if (dq === 0) {
    direction = 'unknown';
    reason = 'price-integrity flagged data as invalid/quarantined';
    volClass = 'UNKNOWN';
  } else if (series.length < 3) {
    direction = 'unknown';
    reason = 'insufficient history for volatility analysis';
    volClass = 'UNKNOWN';
  } else {
    const r = computeRealizedVol(series);
    realizedVol = r;
    const expRange = expectedRange(series);
    expectedRangePct = expRange;
    expansion = expansionSignal(series);

    volClass = classifyVol(realizedVol, expansion);

    if (volClass === 'EXTREME') {
      direction = 'bearish';
      reason = 'extreme volatility — confidence reduced, signal unreliable';
      confidence = clamp(15);
    } else if (volClass === 'HIGH') {
      direction = 'bearish';
      reason = 'high volatility — reduced confidence';
      confidence = clamp(25);
    } else if (volClass === 'LOW' && recoveryPct != null && recoveryPct > 0.5) {
      direction = 'bullish';
      reason = 'low volatility with recovery — stable signal';
      confidence = clamp(45 + recoveryPct * 5);
    } else if (volClass === 'NORMAL' && recoveryPct != null && recoveryPct > 0.5) {
      direction = 'bullish';
      reason = 'normal volatility with recovery';
      confidence = clamp(35 + recoveryPct * 5);
    } else if (volClass === 'LOW') {
      direction = 'neutral';
      reason = 'low volatility, no clear directional momentum';
      confidence = clamp(20);
    } else {
      direction = 'neutral';
      reason = 'normal volatility, mixed signals';
      confidence = clamp(20 + Math.min(30, (100 - realizedVol) * 0.2));
    }
    score = clamp(Math.round(confidence));
    confidence = clamp(confidence);
  }

  const evidence = [];
  if (dq > 0 && series.length >= 3) {
    evidence.push({ claim: 'realized volatility', value: realizedVol.toFixed(1) + '% (mean abs return proxy)', source: 'local_history', confidence: clamp(60 + (100 - realizedVol) * 0.3), timestamp: Date.now() });
    evidence.push({ claim: 'volatility classification', value: volClass, source: 'atlas_volatility_agent', confidence: clamp(50 + (volClass === 'LOW' ? 20 : volClass === 'NORMAL' ? 10 : 0)), timestamp: Date.now() });
    evidence.push({ claim: 'expected short-term range', value: expectedRangePct.toFixed(1) + '%', source: 'local_history', confidence: clamp(40 + (100 - realizedVol) * 0.2), timestamp: Date.now() });
    if (expansion !== 0) evidence.push({ claim: 'volatility expansion', value: (expansion > 0 ? 'expanding' : 'contracting') + ' ' + expansion.toFixed(2), source: 'local_history', confidence: clamp(50), timestamp: Date.now() });
    if (change1hPct != null && Math.abs(change1hPct) > 20) evidence.push({ claim: 'abnormal 1h move', value: change1hPct.toFixed(1) + '%', source: 'candidate_metadata', confidence: clamp(60), timestamp: Date.now() });
  }

  const risks = [];
  if (volClass === 'EXTREME') risks.push('extreme_volatility');
  if (volClass === 'HIGH') risks.push('high_volatility');
  if (expansion > 0.5) risks.push('volatility_expansion');
  if (dq === 0) risks.push('data_integrity_failed');

  const invalidatingConditions = [];
  if (volClass === 'EXTREME') invalidatingConditions.push('extreme volatility undermines technical signal reliability');
  if (volClass === 'HIGH' && recoveryPct != null && recoveryPct < 0.25) invalidatingConditions.push('high volatility + weak recovery — unreliable signal');

  return {
    agent: 'volatility',
    candidate: cand.symbol || '',
    timestamp: Date.now(),
    direction,
    confidence: Math.round(clamp(confidence)),
    score: Math.round(score),
    timeHorizon: volClass === 'EXTREME' || volClass === 'HIGH' ? '5m' : '15m',
    thesis: reason,
    evidence,
    risks,
    invalidatingConditions,
    prediction: predictionObj(direction, score, realizedVol),
    dataQuality: dq > 0 ? 'ok' : integrity.dataQuality || 'ok',
    volatilityClass: volClass,
    realizedVolatility: Math.round(realizedVol),
    expectedRangePct: Math.round(expectedRangePct)
  };

  function computeRealizedVol(series) {
    if (series.length < 3) return 0;
    const rets = [];
    for (let i = 1; i < series.length; i++) {
      const l = series[i].priceUsd != null ? series[i].priceUsd : (series[i].priceSol != null ? series[i].priceSol : 0);
      const p = series[i - 1].priceUsd != null ? series[i - 1].priceUsd : (series[i - 1].priceSol != null ? series[i - 1].priceSol : 0);
      if (p > 0) rets.push(Math.abs((l - p) / p));
    }
    if (!rets.length) return 0;
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    return clamp(mean / 0.05 * 100);
  }

  function expectedRange(series) {
    if (series.length < 3) return 0;
    const rets = [];
    for (let i = 1; i < series.length; i++) {
      const l = series[i].priceUsd != null ? series[i].priceUsd : (series[i].priceSol != null ? series[i].priceSol : 0);
      const p = series[i - 1].priceUsd != null ? series[i - 1].priceUsd : (series[i - 1].priceSol != null ? series[i - 1].priceSol : 0);
      if (p > 0) rets.push((l - p) / p);
    }
    if (!rets.length) return 0;
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
    const stddev = Math.sqrt(variance);
    return clamp(stddev * 2 * 100, 0, 100);
  }

  function expansionSignal(series) {
    if (series.length < 6) return 0;
    const half = Math.floor(series.length / 2);
    const first = series.slice(0, half);
    const second = series.slice(half);
    const v1 = computeRealizedVol(first);
    const v2 = computeRealizedVol(second);
    if (v1 === 0) return 0;
    return clamp((v2 - v1) / v1, -1, 1);
  }

  function classifyVol(realized, expansion) {
    if (realized >= 90) return 'EXTREME';
    if (realized >= 60) return 'HIGH';
    if (realized >= 30) return 'NORMAL';
    return 'LOW';
  }

  function predictionObj(direction, score, vol) {
    if (direction === 'unknown') return { expectedMovePct: 0, probabilityUp: 0, probabilityDown: 0 };
    const base = clamp(score / 100);
    const up = direction === 'bullish' ? base : (direction === 'bearish' ? 1 - base : 0.5);
    const down = direction === 'bearish' ? base : (direction === 'bullish' ? 1 - base : 0.5);
    const expected = (direction === 'bullish' ? 1 : -1) * clamp(score / 15) * Math.max(0, 1 - vol / 100);
    return {
      expectedMovePct: Math.round(clamp(expected, -50, 50)),
      probabilityUp: clamp(up),
      probabilityDown: clamp(down)
    };
  }
}

module.exports = { analyze };
