#!/usr/bin/env node
/**
 * atlas/agents/regime.js — ATLAS Regime Agent.
 *
 * Classifies the current market regime from data available at the decision timestamp.
 * Never uses future trade outcomes.
 *
 * Regimes: TREND_UP, TREND_DOWN, CONSOLIDATION, RECOVERY, DUMP, HIGH_VOLATILITY,
 * LOW_LIQUIDITY, UNKNOWN
 */

'use strict';

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));

const REGIMES = ['TREND_UP', 'TREND_DOWN', 'CONSOLIDATION', 'RECOVERY', 'DUMP', 'HIGH_VOLATILITY', 'LOW_LIQUIDITY', 'UNKNOWN'];

function analyze(input = {}) {
  const cand = input.candidate || {};
  const hist = input.history && input.history.samples ? input.history.samples : [];
  const market = input.market || {};
  const integrity = input.integrity || {};
  const dq = integrity.dataQuality === 'suspicious' || integrity.dataQuality === 'fail' ? 0 : 100;

  const series = Array.isArray(hist) ? hist : [];
  const change1hPct = Number.isFinite(cand.change1hPct) ? cand.change1hPct : null;
  const change5mPct = Number.isFinite(cand.change5mPct) ? cand.change5mPct : null;
  const recoveryPct = Number.isFinite(cand.recoveryPct) ? cand.recoveryPct : null;
  const recoveryStatus = cand.recoveryStatus || null;
  const liquidityUsd = Number.isFinite(cand.liquidityUsd) ? cand.liquidityUsd : 0;

  let regime = 'UNKNOWN';
  let reason = 'insufficient data';
  let confidence = 0;
  let score = 0;
  let corroboratingEvidences = [];
  let trend = 0, vol = 0, recovery = null, dumpSignal = false, consol = false;

  if (dq === 0) {
    regime = 'UNKNOWN';
    reason = 'price-integrity flagged data as invalid/quarantined';
  } else if (series.length < 5) {
    regime = 'UNKNOWN';
    reason = 'insufficient history to classify regime';
  } else {
    trend = computeTrend(series);
    vol = computeTrendVol(series);
    recovery = computeRecoveryRegime(series, recoveryPct, recoveryStatus);
    dumpSignal = drainSignal(series, change1hPct, change5mPct);
    consol = isConsolidating(series);

    regime = classifyRegime(trend, vol, recovery, dumpSignal, consol, liquidityUsd, cand.volume24hUsd);
    reason = regimeReason(regime, trend, vol, recovery, dumpSignal, consol);

    const ev = [];
    if (trend > 1) ev.push('uptrend_signal');
    if (trend < -1) ev.push('downtrend_signal');
    if (recovery === 'RECOVERY') ev.push('recovery_signal');
    if (dumpSignal) ev.push('dump_signal');
    if (consol) ev.push('consolidation_signal');
    corroboratingEvidences = ev;

    confidence = regimeConfidence(regime, series.length, corroboratingEvidences.length);
    score = clamp(Math.round(confidence));
    confidence = clamp(confidence);
  }

  const evidence = [];
  if (dq > 0 && series.length >= 5) {
    evidence.push({ claim: 'market regime', value: regime, source: 'atlas_regime_agent', confidence: clamp(confidence), timestamp: Date.now() });
    evidence.push({ claim: 'trend slope', value: trend.toFixed(2) + '% (series slope proxy)', source: 'local_history', confidence: clamp(50 + Math.min(100, Math.abs(trend) * 10)), timestamp: Date.now() });
    evidence.push({ claim: 'realized volatility', value: vol.toFixed(0) + '%', source: 'local_history', confidence: clamp(45 + Math.min(100, (100 - vol) * 0.3)), timestamp: Date.now() });
    if (recovery === 'RECOVERY') evidence.push({ claim: 'recovery regime', value: 'recovery_opportunity', source: 'atlas_regime_agent', confidence: clamp(55 + recoveryPctIfAvail(series, recoveryPct) * 5), timestamp: Date.now() });
    if (dumpSignal) evidence.push({ claim: 'dump signal', value: 'high_downside_risk', source: 'atlas_regime_agent', confidence: clamp(65), timestamp: Date.now() });
    if (consol) evidence.push({ claim: 'consolidation', value: 'rangebound', source: 'atlas_regime_agent', confidence: clamp(55), timestamp: Date.now() });
    if (corroboratingEvidences.length === 1) evidence.push({ claim: 'regime evidence', value: 'single_corroborating_signal', source: 'atlas_regime_agent', confidence: clamp(35), timestamp: Date.now() });
    else if (corroboratingEvidences.length >= 2) evidence.push({ claim: 'regime evidence', value: corroboratingEvidences.length + ' corroborating signals', source: 'atlas_regime_agent', confidence: clamp(50 + corroboratingEvidences.length * 8), timestamp: Date.now() });
  }

  const risks = [];
  if (regime === 'DUMP' || dumpSignal) risks.push('dump_regime_risk');
  if (regime === 'HIGH_VOLATILITY') risks.push('high_volatility_regime');
  if (regime === 'LOW_LIQUIDITY') risks.push('low_liquidity_regime');
  if (regime === 'TREND_DOWN') risks.push('downtrend regime');
  if (dq === 0) risks.push('data_integrity_failed');

  const invalidatingConditions = [];
  if (regime === 'DUMP') invalidatingConditions.push('dump regime — high probability of further downside');
  if (regime === 'HIGH_VOLATILITY' && vol >= 80) invalidatingConditions.push('extreme regime volatility undermines directional thesis');

  return {
    agent: 'regime',
    candidate: cand.symbol || '',
    timestamp: Date.now(),
    direction: regimeDirection(regime),
    confidence: Math.round(clamp(confidence)),
    score: Math.round(score),
    timeHorizon: '1h',
    thesis: reason,
    evidence,
    risks,
    invalidatingConditions,
    prediction: predictionObj(regimeDirection(regime), score, regime),
    dataQuality: dq > 0 ? 'ok' : integrity.dataQuality || 'ok',
    regime,
    corroboratingEvidences
  };

  function computeTrend(series) {
    if (series.length < 3) return 0;
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

  function computeTrendVol(series) {
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

  function computeRecoveryRegime(series, recoveryPct, recoveryStatus) {
    if (recoveryStatus === 'warming') return 'WARMING';
    if (recoveryPct != null && Number.isFinite(recoveryPct) && recoveryPct > 0.5) return 'RECOVERY';
    if (series.length >= 5 && recentReversal(series)) return 'RECOVERY';
    return null;
  }

  function recentReversal(series) {
    if (series.length < 3) return false;
    const secondLast = series[series.length - 2];
    const last = series[series.length - 1];
    const p2 = secondLast.priceUsd != null ? secondLast.priceUsd : (secondLast.priceSol != null ? secondLast.priceSol : 0);
    const p1 = last.priceUsd != null ? last.priceUsd : (last.priceSol != null ? last.priceSol : 0);
    if (p2 <= 0) return false;
    return (p1 - p2) / p2 > 0.005;
  }

  function drainSignal(series, c1h, c5m) {
    if (c1h != null && c1h < -15) return true;
    if (series.length < 3) return false;
    const last3 = series.slice(-3);
    const p2 = last3[0].priceUsd != null ? last3[0].priceUsd : (last3[0].priceSol != null ? last3[0].priceSol : 0);
    const p1 = last3[last3.length - 1].priceUsd != null ? last3[last3.length - 1].priceUsd : (last3[last3.length - 1].priceSol != null ? last3[last3.length - 1].priceSol : 0);
    if (p2 <= 0) return false;
    return (p1 - p2) / p2 < -0.02;
  }

  function isConsolidating(series) {
    if (series.length < 5) return false;
    const vals = series.map(p => p.priceUsd != null ? p.priceUsd : (p.priceSol != null ? p.priceSol : 0));
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const max = Math.max(...vals);
    const min = Math.min(...vals);
    const range = max - min;
    return mean > 0 && (range / mean) < 0.05;
  }

  function classifyRegime(trend, vol, recovery, dumpSignal, consol, liquidity, volume) {
    if (dumpSignal) return 'DUMP';
    if (recovery === 'RECOVERY' && trend > 1 && vol < 60) return 'RECOVERY';
    if (vol >= 80) return 'HIGH_VOLATILITY';
    if (liquidity > 0 && liquidity < 10000 && volume > 0 && volume < 50000) return 'LOW_LIQUIDITY';
    if (consol) return 'CONSOLIDATION';
    if (trend > 2 && vol < 50) return 'TREND_UP';
    if (trend < -2) return 'TREND_DOWN';
    if (trend > 1) return 'TREND_UP';
    return 'CONSOLIDATION';
  }

  function regimeReason(regime, trend, vol, recovery, dumpSignal, consol) {
    switch (regime) {
      case 'TREND_UP': return 'uptrend regime with moderate volatility';
      case 'TREND_DOWN': return 'downtrend regime';
      case 'CONSOLIDATION': return 'rangebound consolidation';
      case 'RECOVERY': return 'recovery setup — price reversing from dip';
      case 'DUMP': return 'dump regime — sustained downside';
      case 'HIGH_VOLATILITY': return 'highly volatile regime — reduced directional confidence';
      case 'LOW_LIQUIDITY': return 'low liquidity regime — exits may be unreliable';
      default: return 'unknown regime — insufficient data';
    }
  }

  function regimeConfidence(regime, nSamples, nEvidences) {
    let base = 20;
    if (regime === 'TREND_UP' || regime === 'TREND_DOWN' || regime === 'DUMP') base += 15;
    if (regime === 'RECOVERY') base += 20;
    if (regime === 'CONSOLIDATION') base += 10;
    if (nSamples >= 10) base += 15;
    else if (nSamples >= 5) base += 5;
    base += nEvidences * 8;
    return clamp(base);
  }

  function recoveryPctIfAvail(series, recoveryPct) {
    if (recoveryPct != null && Number.isFinite(recoveryPct)) return recoveryPct;
    if (series.length < 2) return 0;
    const l = series[series.length - 1].priceUsd != null ? series[series.length - 1].priceUsd : (series[series.length - 1].priceSol != null ? series[series.length - 1].priceSol : 0);
    const p = series[series.length - 2].priceUsd != null ? series[series.length - 2].priceUsd : (series[series.length - 2].priceSol != null ? series[series.length - 2].priceSol : 0);
    return p > 0 ? clamp(((l - p) / p) * 100, -100, 100) : 0;
  }

  function regimeDirection(regime) {
    switch (regime) {
      case 'TREND_UP': return 'bullish';
      case 'TREND_DOWN': return 'bearish';
      case 'DUMP': return 'bearish';
      case 'RECOVERY': return 'bullish';
      case 'HIGH_VOLATILITY': return 'neutral';
      case 'LOW_LIQUIDITY': return 'neutral';
      case 'CONSOLIDATION': return 'neutral';
      default: return 'unknown';
    }
  }

  function predictionObj(direction, score, regime) {
    if (direction === 'unknown') return { expectedMovePct: 0, probabilityUp: 0, probabilityDown: 0 };
    const base = clamp(score / 100);
    const up = direction === 'bullish' ? base : (direction === 'bearish' ? 1 - base : 0.5);
    const down = direction === 'bearish' ? base : (direction === 'bullish' ? 1 - base : 0.5);
    const regimeMod = regime === 'DUMP' ? -10 : (regime === 'TREND_DOWN' ? -5 : 0);
    const expected = (direction === 'bullish' ? 1 : -1) * (clamp(score / 12) + regimeMod);
    return {
      expectedMovePct: Math.round(clamp(expected, -50, 50)),
      probabilityUp: clamp(up),
      probabilityDown: clamp(down)
    };
  }
}

module.exports = { analyze, REGIMES };
