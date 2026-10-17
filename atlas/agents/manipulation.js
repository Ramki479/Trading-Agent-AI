#!/usr/bin/env node
/**
 * atlas/agents/manipulation.js — ATLAS Manipulation Agent.
 *
 * Looks for:
 *   - abnormal volume
 *   - price spikes
 *   - liquidity withdrawal
 *   - sudden pair changes
 *   - extreme candles
 *   - inconsistent source prices
 *   - suspicious transaction patterns
 *   - pump-and-dump characteristics
 *
 * Returns manipulationRisk: LOW / MEDIUM / HIGH / EXTREME.
 * Never turns this into a hardcoded strategy rule — it is an ATLAS risk signal.
 */

'use strict';

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));

const MANIPULATION_RISK = ['LOW', 'MEDIUM', 'HIGH', 'EXTREME'];

function analyze(input = {}) {
  const cand = input.candidate || {};
  const integrity = input.integrity || {};
  const history = input.history || {};
  const dq = integrity.dataQuality === 'suspicious' || integrity.dataQuality === 'fail' ? 0 : 100;

  const priceUsd = Number.isFinite(cand.priceUsd) ? cand.priceUsd : null;
  const volume24hUsd = Number.isFinite(cand.volume24hUsd) ? cand.volume24hUsd : 0;
  const liquidityUsd = Number.isFinite(cand.liquidityUsd) ? cand.liquidityUsd : 0;
  const liquidityDeltaPct = Number.isFinite(cand.liquidityDeltaPct) ? cand.liquidityDeltaPct : null;
  const change5mPct = Number.isFinite(cand.change5mPct) ? cand.change5mPct : null;
  const change1hPct = Number.isFinite(cand.change1hPct) ? cand.change1hPct : null;
  const buysPct = Number.isFinite(cand.buysPct) ? cand.buysPct : null;
  const priceSource = cand.priceSource || null;
  const pairAddress = cand.pairAddress || null;
  const dex = cand.dex || null;
  const mint = cand.mint || null;

  const series = Array.isArray(history.samples) ? history.samples : [];
  const suspiciousPriceMove = integrity.suspiciousPriceMove === true;
  const pairChanged = integrity.pairChanged === true;
  const sourceDivergence = integrity.sourceDivergence === true;
  const lastPairAddress = integrity.lastPairAddress;
  const lastPairMismatches = integrity.pairChangeEvents ? integrity.pairChangeEvents.length : 0;

  let direction = 'neutral';
  let reason = 'insufficient data';
  let confidence = 0;
  let score = 0;
  let status = 'NO_DATA';
  let manipulationRisk = 'LOW';
  let riskScore = 0;

  const evidence = [];
  const risks = [];
  const invalidatingConditions = [];

  if (mint == null) {
    risks.push('missing_mint');
    evidence.push({ claim: 'mint identity', value: 'MISSING', source: 'candidate_metadata', confidence: clamp(30), timestamp: Date.now(), sourceDetail: 'missing_mint' });
  } else {
    evidence.push({ claim: 'mint identity', value: mint, source: 'candidate_metadata', confidence: clamp(80), timestamp: Date.now(), sourceDetail: 'mint' });
  }

  if (dq === 0) {
    direction = 'unknown';
    reason = 'price-integrity flagged data as invalid/quarantined';
    status = 'FAIL';
    manipulationRisk = 'EXTREME';
    riskScore = clamp(riskScore + 50);
  } else if (!priceUsd || liquidityUsd <= 0 && volume24hUsd <= 0) {
    direction = 'neutral';
    reason = 'insufficient data to assess manipulation risk';
    status = 'NO_DATA';
  } else {
    status = 'PARTIAL';
    let manipScore = 0;

    // abnormal volume vs expected
    const avgVolume = Number.isFinite(input.universeAvgVolumeUsd) ? input.universeAvgVolumeUsd : 0;
    const volumeSpike = avgVolume > 0 && volume24hUsd > 0 ? clamp((volume24hUsd - avgVolume) / avgVolume, -1, 10) : 0;
    if (volumeSpike > 2) {
      manipScore += 15;
      evidence.push({ claim: 'volume spike', value: 'volume ' + volumeSpike.toFixed(1) + 'x universe avg', source: 'universe_average_volume', confidence: clamp(50 + volumeSpike * 5), timestamp: Date.now(), sourceDetail: 'volume_spike' });
      risks.push('abnormal_volume');
    } else {
      evidence.push({ claim: 'volume vs universe avg', value: (avgVolume > 0 ? (volume24hUsd / avgVolume).toFixed(1) + 'x' : 'n/a'), source: 'universe_average_volume', confidence: clamp(35), timestamp: Date.now(), sourceDetail: 'volume_vs_avg' });
    }

    // price spikes
    if (change5mPct != null && Math.abs(change5mPct) > 15) {
      manipScore += 15;
      evidence.push({ claim: '5m price spike', value: change5mPct.toFixed(1) + '% (extreme short-term move)', source: 'local_history', confidence: clamp(55 + Math.min(45, Math.abs(change5mPct) * 1.5)), timestamp: Date.now(), sourceDetail: '5m_price_spike' });
      risks.push('price_spike');
    }
    if (change1hPct != null && Math.abs(change1hPct) > 30) {
      manipScore += 10;
      evidence.push({ claim: '1h price spike', value: change1hPct.toFixed(1) + '% (extreme hourly move)', source: 'local_history', confidence: clamp(50 + Math.min(50, Math.abs(change1hPct) * 1.2)), timestamp: Date.now(), sourceDetail: '1h_price_spike' });
      risks.push('price_spike');
    }

    // liquidity withdrawal
    if (liquidityDeltaPct != null && liquidityDeltaPct < -20) {
      manipScore += 20;
      evidence.push({ claim: 'liquidity withdrawal', value: liquidityDeltaPct.toFixed(0) + '% liquidity drop', source: 'on_chain_data', confidence: clamp(60 + Math.min(40, -liquidityDeltaPct * 1.2)), timestamp: Date.now(), sourceDetail: 'liquidity_withdrawal' });
      risks.push('liquidity_withdrawal');
      invalidatingConditions.push('sudden liquidity withdrawal — exit risk');
    } else if (liquidityDeltaPct != null && liquidityDeltaPct > 30) {
      evidence.push({ claim: 'liquidity increase', value: liquidityDeltaPct.toFixed(0) + '% (possibly artificial)', source: 'on_chain_data', confidence: clamp(40), timestamp: Date.now(), sourceDetail: 'liquidity_increase' });
      manipScore += 5;
    }

    // sudden pair change
    if (pairChanged) {
      manipScore += 30;
      evidence.push({ claim: 'pair change', value: 'PAIR_CHANGED: ' + (lastPairAddress || 'unknown') + ' -> ' + (pairAddress || 'unknown'), source: 'price_integrity', confidence: clamp(85), timestamp: Date.now(), sourceDetail: 'pair_changed' });
      risks.push('pair_change');
      invalidatingConditions.push('pair identity changed unexpectedly — potential pool-switch manipulation');
    } else if (lastPairAddress && pairAddress && lastPairAddress !== pairAddress) {
      evidence.push({ claim: 'pair address mismatch', value: lastPairAddress + ' -> ' + pairAddress, source: 'price_integrity', confidence: clamp(70), timestamp: Date.now(), sourceDetail: 'pair_mismatch' });
      manipScore += 15;
      risks.push('pair_mismatch');
    }

    // extreme candles (from series)
    const extremeCandles = detectExtremeCandles(series);
    if (extremeCandles > 0) {
      manipScore += clamp(extremeCandles * 8);
      evidence.push({ claim: 'extreme candles', value: extremeCandles + ' candles with >30% magnitude', source: 'local_history', confidence: clamp(50 + extremeCandles * 10), timestamp: Date.now(), sourceDetail: 'extreme_candles' });
      risks.push('extreme_candles');
    }

    // inconsistent source prices
    if (sourceDivergence) {
      manipScore += 20;
      evidence.push({ claim: 'source divergence', value: 'CIRCUIT and DEXSCREENER disagree beyond threshold', source: 'price_integrity', confidence: clamp(75), timestamp: Date.now(), sourceDetail: 'source_divergence' });
      risks.push('source_divergence');
    }

    // buy/sell imbalance
    if (buysPct != null) {
      if (buysPct > 90) {
        manipScore += 10;
        evidence.push({ claim: 'buy imbalance', value: buysPct.toFixed(0) + '% buys (potential wash/pump)', source: 'candidate_metadata', confidence: clamp(45 + (buysPct - 90) * 1), timestamp: Date.now(), sourceDetail: 'buy_imbalance' });
        risks.push('buy_imbalance');
      } else if (buysPct < 20) {
        manipScore += 8;
        evidence.push({ claim: 'sell imbalance', value: buysPct.toFixed(0) + '% buys (heavy selling)', source: 'candidate_metadata', confidence: clamp(40 + (20 - buysPct) * 1), timestamp: Date.now(), sourceDetail: 'sell_imbalance' });
        risks.push('sell_imbalance');
      }
    }

    // pump-and-dump characteristics
    const pumpAndDump = isPumpAndDumpProfile(cand, series, volumeSpike, change5mPct, change1hPct, buysPct, liquidityDeltaPct);
    if (pumpAndDump > 0) {
      manipScore += clamp(pumpAndDump * 5);
      if (pumpAndDump >= 2) {
        evidence.push({ claim: 'pump-and-dump profile', value: 'multiple pump-and-dump signals: ' + pumpAndDump, source: 'atlas_manipulation_agent', confidence: clamp(55 + pumpAndDump * 8), timestamp: Date.now(), sourceDetail: 'pump_and_dump' });
        risks.push('pump_and_dump_profile');
        invalidatingConditions.push('pump-and-dump characteristics detected — high manipulation risk');
      }
    }

    // price source
    if (priceSource) {
      evidence.push({ claim: 'price source', value: priceSource, source: 'candidate_metadata', confidence: clamp(50), timestamp: Date.now(), sourceDetail: 'price_source' });
    }
    if (pairAddress) {
      evidence.push({ claim: 'pair address', value: pairAddress, source: 'candidate_metadata', confidence: clamp(60), timestamp: Date.now(), sourceDetail: 'pair_address' });
    }
    if (dex) {
      evidence.push({ claim: 'dex', value: dex, source: 'candidate_metadata', confidence: clamp(60), timestamp: Date.now(), sourceDetail: 'dex' });
    }

    riskScore = clamp(manipScore);
    manipulationRisk = classifyRisk(riskScore, pairChanged);

    if (manipulationRisk === 'EXTREME') {
      direction = 'bearish';
      reason = 'extreme manipulation risk — data-integrity + suspicious patterns';
      confidence = clamp(50);
    } else if (manipulationRisk === 'HIGH') {
      direction = 'bearish';
      reason = 'high manipulation risk — multiple red flags';
      confidence = clamp(40);
    } else if (manipulationRisk === 'MEDIUM') {
      direction = 'bearish';
      reason = 'moderate manipulation risk — some suspicious signals';
      confidence = clamp(30);
    } else {
      direction = 'neutral';
      reason = 'low manipulation risk — no significant red flags';
      confidence = clamp(25 + Math.min(20, (100 - riskScore) * 0.3));
    }

    score = clamp(Math.round(confidence));
    confidence = clamp(confidence);
  }

  return {
    agent: 'manipulation',
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
    prediction: predictionObj(direction, score, riskScore),
    dataQuality: dq > 0 ? 'ok' : integrity.dataQuality || 'ok',
    status,
    manipulationRisk,
    manipulationRiskScore: Math.round(riskScore),
    pairChangeCount: lastPairMismatches
  };

  function detectExtremeCandles(series) {
    if (!series.length) return 0;
    let count = 0;
    for (let i = 1; i < series.length; i++) {
      const l = series[i].priceUsd != null ? series[i].priceUsd : (series[i].priceSol != null ? series[i].priceSol : 0);
      const p = series[i - 1].priceUsd != null ? series[i - 1].priceUsd : (series[i - 1].priceSol != null ? series[i - 1].priceSol : 0);
      if (p > 0 && Math.abs((l - p) / p) > 0.3) count++;
    }
    return count;
  }

  function isPumpAndDumpProfile(cand, series, volumeSpike, c5m, c1h, buysPct, liqDelta) {
    let signals = 0;
    if (volumeSpike > 3) signals++;
    if (c5m != null && c5m > 20) signals++;
    if (c1h != null && c1h > 25) signals++;
    if (buysPct != null && buysPct > 85) signals++;
    if (liqDelta != null && liqDelta < -15) signals++;
    if (series.length >= 3 && lastCandleReversed(series)) signals++;
    return signals;
  }

  function lastCandleReversed(series) {
    if (series.length < 3) return false;
    const last = series[series.length - 1];
    const prev = series[series.length - 2];
    const l = last.priceUsd != null ? last.priceUsd : (last.priceSol != null ? last.priceSol : 0);
    const p = prev.priceUsd != null ? prev.priceUsd : (prev.priceSol != null ? prev.priceSol : 0);
    if (p <= 0) return false;
    // pump then dump: large positive candle followed by reversal
    const recent = (l - p) / p;
    if (recent > 0.2) {
      if (series.length >= 4) {
        const pprev = series[series.length - 3];
        const pp = pprev.priceUsd != null ? pprev.priceUsd : (pprev.priceSol != null ? pprev.priceSol : 0);
        if (pp > 0 && (p - pp) / pp > 0.1 && (l - p) / p < -0.1) return true;
      }
    }
    return false;
  }

  function classifyRisk(score, pairChanged) {
    if (pairChanged) return 'EXTREME';
    if (score >= 60) return 'HIGH';
    if (score >= 30) return 'MEDIUM';
    return 'LOW';
  }

  function predictionObj(direction, score, riskScore) {
    if (direction === 'unknown') return { expectedMovePct: 0, probabilityUp: 0, probabilityDown: 0 };
    const base = clamp(score / 100);
    const up = direction === 'bullish' ? base : (direction === 'bearish' ? 1 - base : 0.5);
    const down = direction === 'bearish' ? base : (direction === 'bullish' ? 1 - base : 0.5);
    const riskBias = -riskScore / 10;
    const expected = (direction === 'bullish' ? 1 : -1) * clamp(score / 15) + riskBias;
    return {
      expectedMovePct: Math.round(clamp(expected, -50, 50)),
      probabilityUp: clamp(up + riskBias),
      probabilityDown: clamp(down)
    };
  }
}

module.exports = { analyze, MANIPULATION_RISK };
