#!/usr/bin/env node
/**
 * atlas/agents/momentum.js — ATLAS Momentum Agent.
 *
 * Analyzes momentum across horizons and detects recovery vs dead-cat bounce vs
 * momentum continuation vs exhaustion vs failed recovery.
 */

'use strict';

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));

function analyze(input = {}) {
  const cand = input.candidate || {};
  const hist = input.history && input.history.samples ? input.history.samples : [];
  const integrity = input.integrity || {};
  const dq = integrity.dataQuality === 'suspicious' || integrity.dataQuality === 'fail' ? 0 : 100;

  const series = Array.isArray(hist) ? hist : [];
  const change5mPct = Number.isFinite(cand.change5mPct) ? cand.change5mPct : null;
  const change1hPct = Number.isFinite(cand.change1hPct) ? cand.change1hPct : null;
  const recoveryPct = Number.isFinite(cand.recoveryPct) ? cand.recoveryPct : null;

  let direction = 'neutral';
  let reason = 'insufficient data';
  let confidence = 0;
  let score = 0;
  let momentumClass = 'unknown';
  let m5 = 0, m15 = 0, m60 = 0, accel = 0, exhaustion = 0, deadCat = false;

  if (dq === 0) {
    direction = 'unknown';
    reason = 'price-integrity flagged data as invalid/quarantined';
  } else if (series.length < 3) {
    direction = 'unknown';
    reason = 'insufficient history for momentum analysis';
  } else {
    m5 = momentumAt(series, 5);
    m15 = momentumAt(series, 15);
    m60 = momentumAt(series, 60);
    accel = acceleration(m5, m15, m60);
    exhaustion = detectExhaustion(series, m5, m15);
    deadCat = detectDeadCat(series, recoveryPct, m5, m15, m60);

    momentumClass = classifyMomentum(m5, m15, m60, accel, exhaustion, deadCat);

    if (deadCat) {
      direction = 'bearish';
      reason = 'dead-cat bounce: recovery appears exhausted';
      confidence = clamp(40 + (1 - exhaustion) * 20);
    } else if (exhaustion > 0.7 && m5 < 0) {
      direction = 'bearish';
      reason = 'momentum exhaustion detected';
      confidence = clamp(35 + exhaustion * 15);
    } else if (m5 > 1 && m15 > 0.5 && m60 > -2) {
      direction = 'bullish';
      reason = 'momentum continuation across horizons';
      confidence = clamp(40 + Math.min(100, (m5 + 10) * 5));
    } else if (m5 > 0.5 && recoveryPct != null && recoveryPct > 0.5) {
      direction = 'bullish';
      reason = 'short-term recovery momentum';
      confidence = clamp(30 + recoveryPct * 5);
    } else if (m5 < -1) {
      direction = 'bearish';
      reason = 'short-term momentum negative';
      confidence = clamp(30 + Math.min(100, (-m5 + 1) * 10));
    } else {
      direction = 'neutral';
      reason = 'mixed momentum: 5m=' + m5.toFixed(2) + ' 15m=' + m15.toFixed(2) + ' 1h=' + m60.toFixed(2);
      confidence = clamp(20 + Math.abs(m5) * 8);
    }
    score = clamp(Math.round(confidence));
    confidence = clamp(confidence);
  }

  const evidence = [];
  if (dq > 0 && series.length >= 3) {
    evidence.push({ claim: '5m momentum', value: m5.toFixed(2) + '%', source: 'local_history', confidence: clamp(60 + Math.min(100, Math.abs(m5) * 10)), timestamp: Date.now(), horizon: '5m' });
    evidence.push({ claim: '15m momentum', value: m15.toFixed(2) + '%', source: 'local_history', confidence: clamp(50 + Math.min(100, Math.abs(m15) * 10)), timestamp: Date.now(), horizon: '15m' });
    evidence.push({ claim: '1h momentum', value: m60.toFixed(2) + '%', source: 'local_history', confidence: clamp(40 + Math.min(100, Math.abs(m60) * 5)), timestamp: Date.now(), horizon: '1h' });
    evidence.push({ claim: 'acceleration', value: accel.toFixed(2), source: 'local_history', confidence: clamp(50 + Math.min(100, Math.abs(accel) * 10)), timestamp: Date.now() });
    evidence.push({ claim: 'momentum classification', value: momentumClass, source: 'atlas_momentum_agent', confidence: clamp(45 + confidence), timestamp: Date.now() });
    if (momentumClass === 'dead_cat_bounce') evidence.push({ claim: 'dead-cat bounce', value: 'detected', source: 'atlas_momentum_agent', confidence: clamp(55), timestamp: Date.now() });
    if (exhaustion > 0.5) evidence.push({ claim: 'exhaustion level', value: exhaustion.toFixed(2), source: 'atlas_momentum_agent', confidence: clamp(50), timestamp: Date.now() });
  }

  const risks = [];
  if (momentumClass === 'dead_cat_bounce') risks.push('dead_cat_bounce');
  if (momentumClass === 'exhaustion') risks.push('momentum_exhaustion');
  if (momentumClass === 'failed_recovery') risks.push('failed_recovery');
  if (dq === 0) risks.push('data_integrity_failed');

  const invalidatingConditions = [];
  if (momentumClass === 'dead_cat_bounce') invalidatingConditions.push('recovery appears exhausted — momentum thesis invalidated');
  if (momentumClass === 'failed_recovery') invalidatingConditions.push('failed recovery — momentum signal unreliable');

  return {
    agent: 'momentum',
    candidate: cand.symbol || '',
    timestamp: Date.now(),
    direction,
    confidence: Math.round(clamp(confidence)),
    score: Math.round(score),
    timeHorizon: '5m',
    thesis: reason,
    evidence,
    risks,
    invalidatingConditions,
    prediction: predictionObj(direction, score),
    dataQuality: dq > 0 ? 'ok' : integrity.dataQuality || 'ok'
  };

  function momentumAt(series, window) {
    if (series.length < 2) return 0;
    const start = Math.max(0, series.length - window);
    const startP = series[start].priceUsd != null ? series[start].priceUsd : (series[start].priceSol != null ? series[start].priceSol : 0);
    const endP = series[series.length - 1].priceUsd != null ? series[series.length - 1].priceUsd : (series[series.length - 1].priceSol != null ? series[series.length - 1].priceSol : 0);
    if (startP <= 0) return 0;
    return clamp(((endP - startP) / startP) * 100, -100, 100);
  }

  function acceleration(m5, m15, m60) {
    const recent = m5;
    const older = (m15 + m60) / 2;
    return clamp((recent - older) * 10, -100, 100);
  }

  function detectExhaustion(series, m5, m15) {
    if (series.length < 4) return 0;
    const last5 = series.slice(-5);
    const returns = [];
    for (let i = 1; i < last5.length; i++) {
      const l = last5[i].priceUsd != null ? last5[i].priceUsd : (last5[i].priceSol != null ? last5[i].priceSol : 0);
      const p = last5[i - 1].priceUsd != null ? last5[i - 1].priceUsd : (last5[i - 1].priceSol != null ? last5[i - 1].priceSol : 0);
      if (p > 0) returns.push(Math.abs((l - p) / p));
    }
    if (!returns.length) return 0;
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const trend = returns.length >= 3 ? (returns[returns.length - 1] - returns[0]) / Math.max(returns[0], 0.0001) : 0;
    return clamp((mean + Math.max(0, trend)) * 20, 0, 1);
  }

  function detectDeadCat(series, recoveryPct, m5, m15, m60) {
    if (series.length < 4) return false;
    if (recoveryPct != null && recoveryPct > 0.5 && m5 > 0 && m15 > 0 && m60 < -5) return true;
    if (m5 > 0.5 && m15 < 0 && m60 < -5) return true;
    return false;
  }

  function classifyMomentum(m5, m15, m60, accel, exhaustion, deadCat) {
    if (deadCat) return 'dead_cat_bounce';
    if (exhaustion > 0.7 && m5 <= 0) return 'exhaustion';
    if (m5 > 1 && m15 > 0.5 && m60 > -2) return 'momentum_continuation';
    if (m5 > 0 && m15 > 0 && m60 > -10) return 'failed_recovery' ? 'failed_recovery' : 'neutral';
    if (m5 < -1) return 'momentum_down';
    return 'neutral';
  }

  function predictionObj(direction, score) {
    if (direction === 'unknown') return { expectedMovePct: 0, probabilityUp: 0, probabilityDown: 0 };
    const base = clamp(score / 100);
    const up = direction === 'bullish' ? base : (direction === 'bearish' ? 1 - base : 0.5);
    const down = direction === 'bearish' ? base : (direction === 'bullish' ? 1 - base : 0.5);
    const expected = (direction === 'bullish' ? 1 : -1) * clamp(score / 12);
    return {
      expectedMovePct: Math.round(clamp(expected, -50, 50)),
      probabilityUp: clamp(up),
      probabilityDown: clamp(down)
    };
  }
}

module.exports = { analyze };
