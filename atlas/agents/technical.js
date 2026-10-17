#!/usr/bin/env node
/**
 * atlas/agents/technical.js — ATLAS Technical Agent.
 *
 * Deterministic analysis of supplied price + history + 5m recovery.
 * Does NOT replace V1 technical rules — provides independent research context.
 */

'use strict';

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));

/**
 * @param input { candidate, history, integrity, market? }
 *   history: { samples: [ { ts, priceUsd, priceSol, source } ] }
 *   integrity: from price-integrity verdict
 */
function analyze(input = {}) {
  const cand = input.candidate || {};
  const hist = input.history && input.history.samples ? input.history.samples : [];
  const integrity = input.integrity || {};
  const dq = integrity.dataQuality === 'suspicious' ? 0 : (integrity.dataQuality === 'fail' ? 0 : 100);

  let direction = 'neutral';
  let reason = 'insufficient data';
  let confidence = 0;
  let score = 0;

  const priceUsd = Number.isFinite(cand.priceUsd) ? cand.priceUsd : null;
  const priceSol = Number.isFinite(cand.priceSol) ? cand.priceSol : null;
  const change1hPct = Number.isFinite(cand.change1hPct) ? cand.change1hPct : null;
  const recoveryPct = Number.isFinite(cand.recoveryPct) ? cand.recoveryPct : null;
  const series = Array.isArray(hist) ? hist : [];

  const trend = computeTrend(series);
  const momentum = computeMomentum(series);
  const recStrength = computeRecoveryStrength(recoveryPct, series);
  const vol = computeVolatility(series);
  const volumeConf = computeVolumeConfirmation(cand.volume24hUsd, cand.liquidityUsd);

  if (dq === 0) {
    direction = 'unknown';
    reason = 'price-integrity flagged data as invalid/quarantined';
  } else if (series.length < 3) {
    direction = 'unknown';
    reason = 'insufficient price history for technical analysis';
  } else {
    const ema = simpleEma(series, 5);
    const priceAboveEma = ema != null && priceUsd != null && priceUsd > ema;
    const trendUp = trend > 0;

    if (trendUp && recStrength > 0.5 && vol < 70) {
      direction = 'bullish';
      reason = 'uptrend, strong recovery, moderate volatility';
      confidence = clamp(50 + recStrength * 20 + (priceAboveEma ? 10 : 0));
    } else if (!trendUp && recStrength > 0.4 && vol < 60) {
      direction = 'bullish';
      reason = 'recovery from dip, moderate volatility';
      confidence = clamp(30 + recStrength * 30);
    } else if (!trendUp && recStrength < 0.1 && vol > 60) {
      direction = 'bearish';
      reason = 'downtrend, weak recovery, high volatility';
      confidence = clamp(30 + (1 - vol / 100) * 20);
    } else if (vol >= 90) {
      direction = 'bearish';
      reason = 'extreme volatility, recovery unproven';
      confidence = clamp(20 + Math.max(0, (1 - vol / 100)) * 10);
    } else {
      direction = 'neutral';
      reason = 'mixed signals: trend=' + trend.toFixed(2) + ' recovery=' + recStrength.toFixed(2) + ' vol=' + Math.round(vol);
      confidence = clamp(20 + Math.abs(trend) * 10);
    }
    score = clamp(Math.round(confidence));
    confidence = clamp(confidence);
  }

  const bb = bollingerProxy(series);

  const evidence = [];
  if (dq > 0) {
    evidence.push({ claim: 'price trend', value: trend.toFixed(3) + ' priceUsd/series slope', source: 'local_history', confidence: clamp(60 + Math.abs(trend) * 10), timestamp: Date.now(), sourceDetail: 'series_samples' });
    evidence.push({ claim: '5m recovery strength', value: recStrength.toFixed(2) + ' (recoveryPct=' + (recoveryPct != null ? recoveryPct.toFixed(2) : 'n/a') + ')', source: 'recovery_signal', confidence: clamp(50 + recStrength * 20), timestamp: Date.now() });
    evidence.push({ claim: 'momentum', value: momentum.toFixed(2) + ' (recent slope)', source: 'local_history', confidence: clamp(50 + Math.abs(momentum) * 10), timestamp: Date.now() });
    evidence.push({ claim: 'volatility', value: vol.toFixed(0) + '% (realized proxy)', source: 'local_history', confidence: clamp(50 + (100 - vol) * 0.3), timestamp: Date.now() });
    if (bb != null) evidence.push({ claim: 'bollinger position', value: bb.toFixed(2) + ' (price vs BB proxy)', source: 'local_history', confidence: clamp(40 + Math.abs(bb) * 10), timestamp: Date.now() });
    evidence.push({ claim: 'volume confirmation', value: volumeConf.toFixed(0) + '%', source: 'candidate_metadata', confidence: clamp(50 + volumeConf), timestamp: Date.now() });
  }

  const risks = [];
  if (vol >= 85) risks.push('high_volatility_risk');
  if (recStrength < 0.2) risks.push('weak_recovery');
  if (dq === 0) risks.push('data_integrity_failed');

  const invalidatingConditions = [];
  if (recStrength < 0.25) invalidatingConditions.push('recovery below strategy floor');
  if (vol >= 95) invalidatingConditions.push('extreme volatility undermines technical signal');

  return {
    agent: 'technical',
    candidate: cand.symbol || '',
    timestamp: Date.now(),
    direction,
    confidence: Math.round(clamp(confidence)),
    score: Math.round(score),
    timeHorizon: vol > 70 ? '5m' : '15m',
    thesis: reason,
    evidence,
    risks,
    invalidatingConditions,
    prediction: predictionObj(direction, score, vol),
    dataQuality: dq > 0 ? 'ok' : integrity.dataQuality || 'ok'
  };
}

function computeTrend(series) {
  if (series.length < 2) return 0;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < series.length; i++) {
    const p = series[i].priceUsd != null ? series[i].priceUsd : (series[i].priceSol != null ? series[i].priceSol : 0);
    sx += i; sy += p; sxx += i * i; sxy += i * p;
  }
  const n = series.length;
  const denom = n * sxx - sx * sx || 1;
  const slope = (n * sxy - sx * sy) / denom;
  const meanY = sy / n;
  return meanY > 0 ? clamp(slope / meanY * 100, -100, 100) : 0;
}

function computeMomentum(series) {
  if (series.length < 2) return 0;
  const last = series[series.length - 1];
  const prev = series[series.length - 2];
  const l = last.priceUsd != null ? last.priceUsd : (last.priceSol != null ? last.priceSol : 0);
  const p = prev.priceUsd != null ? prev.priceUsd : (prev.priceSol != null ? prev.priceSol : 0);
  return p > 0 ? clamp(((l - p) / p) * 100, -100, 100) : 0;
}

function computeRecoveryStrength(recoveryPct, series) {
  if (recoveryPct != null && Number.isFinite(recoveryPct)) {
    return clamp((recoveryPct - 0) / 8, 0, 1);
  }
  if (series.length < 2) return 0;
  const last = series[series.length - 1];
  const prev = series[series.length - 2];
  const l = last.priceUsd != null ? last.priceUsd : (last.priceSol != null ? last.priceSol : 0);
  const p = prev.priceUsd != null ? prev.priceUsd : (prev.priceSol != null ? prev.priceSol : 0);
  if (p <= 0) return 0;
  const rec = (l - p) / p * 100;
  return clamp((rec - 0) / 8, 0, 1);
}

function computeVolatility(series) {
  if (series.length < 3) return 0;
  const ret = [];
  for (let i = 1; i < series.length; i++) {
    const l = series[i].priceUsd != null ? series[i].priceUsd : (series[i].priceSol != null ? series[i].priceSol : 0);
    const p = series[i - 1].priceUsd != null ? series[i - 1].priceUsd : (series[i - 1].priceSol != null ? series[i - 1].priceSol : 0);
    if (p > 0) ret.push(Math.abs((l - p) / p));
  }
  if (!ret.length) return 0;
  const mean = ret.reduce((a, b) => a + b, 0) / ret.length;
  const variance = ret.reduce((a, b) => a + (b - mean) ** 2, 0) / ret.length;
  const stddev = Math.sqrt(variance);
  const v = clamp(mean / 0.05 * 100);
  return Math.round(v);
}

function computeVolumeConfirmation(volume, liquidity) {
  const vol = Number.isFinite(volume) ? volume : 0;
  const liq = Number.isFinite(liquidity) ? liquidity : 0;
  if (liq <= 0) return 0;
  const r = vol / liq;
  return clamp(r * 100, 0, 100);
}

function simpleEma(series, period) {
  if (series.length < period) return null;
  let sum = 0, n = 0;
  for (let i = series.length - period; i < series.length; i++) {
    const v = series[i].priceUsd != null ? series[i].priceUsd : (series[i].priceSol != null ? series[i].priceSol : 0);
    sum += v; n++;
  }
  return n > 0 ? sum / n : null;
}

function bollingerProxy(series) {
  if (series.length < 5) return null;
  const slice = series.slice(-5);
  const vals = slice.map(p => p.priceUsd != null ? p.priceUsd : (p.priceSol != null ? p.priceSol : 0));
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
  const stddev = Math.sqrt(variance);
  const last = vals[vals.length - 1];
  if (stddev === 0) return 0;
  const z = (last - mean) / stddev;
  return clamp(z);
}

function predictionObj(direction, score, vol) {
  if (direction === 'unknown') return { expectedMovePct: 0, probabilityUp: 0, probabilityDown: 0 };
  const base = clamp(score / 100);
  const up = direction === 'bullish' ? base : (direction === 'bearish' ? 1 - base : 0.5);
  const down = direction === 'bearish' ? base : (direction === 'bullish' ? 1 - base : 0.5);
  const expected = (direction === 'bullish' ? 1 : -1) * clamp(score / 10) * (1 - vol / 200);
  return {
    expectedMovePct: Math.round(clamp(expected, -50, 50)),
    probabilityUp: clamp(up),
    probabilityDown: clamp(down)
  };
}

module.exports = { analyze };
