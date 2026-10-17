#!/usr/bin/env node
/**
 * agents/technical-analyst.js — TradingAgents Technical Analyst (deterministic).
 *
 * Pure analysis of the price/volume/liquidity/recovery facts for ONE candidate
 * or open position. No I/O, no LLM, no execution authority. It only ever
 * derives numbers from the observed data supplied in `input` — never invents
 * price, volume, liquidity or market values.
 *
 * Output schema:
 *   { agent, direction: bullish|neutral|bearish, confidence: 0..100,
 *     momentum: 0..100, recoveryStrength: 0..100, volatility: 0..100,
 *     volumeConfirmation: 0..100, reasoning: string[],
 *     dataQuality: ok|insufficient_history }
 */
'use strict';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));

function round(n) {
  return Math.round(n * 100) / 100;
}

/** Per-sample volatility from the local real price series (priceSol). */
function sampleVolatility(samples) {
  const sols = (Array.isArray(samples) ? samples : [])
    .map((s) => Number(s && s.priceSol))
    .filter((v) => Number.isFinite(v) && v > 0);
  if (sols.length < 4) return { score: 0, pct: null, n: sols.length };
  let prev = null;
  const logs = [];
  for (const v of sols) {
    if (prev && v > 0) logs.push(Math.log(v / prev));
    prev = v;
  }
  if (logs.length < 3) return { score: 0, pct: null, n: sols.length };
  const mean = logs.reduce((a, b) => a + b, 0) / logs.length;
  const variance = logs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / logs.length;
  const stdPct = Math.sqrt(Math.max(0, variance)) * 100; // per-sample % std
  // 1% per-sample σ ≈ quiet; 8%+ per-sample σ ≈ extreme for this universe.
  return { score: clamp(stdPct * 12, 0, 100), pct: round(stdPct), n: sols.length };
}

/**
 * @param input { candidate, history?, market? }
 *   candidate: { change1hPct, change5mPct, recoveryPct, recoveryStatus,
 *                recoverySamples, priceUsd, priceSol, liquidityUsd,
 *                volume24hUsd, score, symbol, mint }
 *   history:   { samples: [{ts, priceUsd, priceSol}], warming }
 */
function analyze(input = {}) {
  const cand = input.candidate || {};
  const history = input.history || {};
  const reasoning = [];
  const insufficient = history.warming ||
    !(Number.isFinite(cand.recoveryPct) && Number.isFinite(cand.change1hPct));

  // ---- momentum (0..100): local 5m recovery inside the strategy band -------
  let momentum = 0;
  if (Number.isFinite(cand.recoveryPct)) {
    // 0.25% → ~10, 2% → ~45, 5% → ~75, 8% → 100 (the V1 buyable band is 0.25..8)
    momentum = clamp(((cand.recoveryPct - 0) / 8) * 100, 0, 100);
    reasoning.push(`local 5m recovery ${cand.recoveryPct.toFixed(2)}% → momentum ${Math.round(momentum)}/100`);
  } else {
    reasoning.push('5m recovery insufficient_history (warming or no baseline)');
  }

  // ---- recovery strength (0..100): persistence + depth of the dip ----------
  let recoveryStrength = 0;
  if (Number.isFinite(cand.recoveryPct) && Number.isFinite(cand.change1hPct)) {
    const rec = clamp(((cand.recoveryPct - 0.25) / (8 - 0.25)) * 100, 0, 100);
    const dip = clamp(((-35 - Math.min(0, cand.change1hPct)) / 35) * 100, 0, 100); // deeper dip inside band
    recoveryStrength = round(rec * 0.7 + dip * 0.3);
    reasoning.push(`1h change ${cand.change1hPct.toFixed(2)}% (band -35..+15) → dip depth ${Math.round(dip)}/100`);
  }

  // ---- volume confirmation (0..100): turnover vs liquidity ------------------
  let volumeConfirmation = 0;
  const liq = Number(cand.liquidityUsd) || 0;
  const vol = Number(cand.volume24hUsd) || 0;
  if (liq > 0 && vol > 0) {
    const turnover = vol / liq;
    volumeConfirmation = round(clamp((turnover / 5) * 100, 0, 100));
    reasoning.push(`24h volume ${Math.round(vol).toLocaleString('en-US')} vs liquidity ${Math.round(liq).toLocaleString('en-US')} → turnover ${turnover.toFixed(2)}x`);
  } else {
    reasoning.push('no volume/liquidity data — volume confirmation 0');
  }

  // ---- volatility (0..100) from the local real series ----------------------
  const volRes = sampleVolatility(history.samples);
  const volatility = volRes.score;
  if (volRes.pct == null) reasoning.push('insufficient history for volatility');
  else reasoning.push(`local series volatility ≈ ${volRes.pct}% per sample → ${Math.round(volatility)}/100`);

  // ---- direction + confidence ----------------------------------------------
  let direction = 'neutral';
  let confidence = 0;
  if (!insufficient) {
    const bullishStrength = momentum * 0.45 + volumeConfirmation * 0.25 + recoveryStrength * 0.3;
    const riskPenalty = volatility > 85 ? 40 : volatility > 65 ? 18 : 0;
    const net = bullishStrength - riskPenalty;
    if (net >= 55) direction = 'bullish';
    else if (net <= 30) direction = 'bearish';
    else direction = 'neutral';
    confidence = round(clamp(net, 0, 100));
    reasoning.push(`technical net ${Math.round(net)}/100 (volatility penalty ${Math.round(riskPenalty)}) → ${direction}`);
  } else {
    direction = 'neutral';
    reasoning.push('insufficient history — direction withheld (never fabricated)');
  }

  return {
    agent: 'technical',
    direction,
    confidence,
    momentum: Math.round(momentum),
    recoveryStrength: Math.round(recoveryStrength),
    volatility: Math.round(volatility),
    volumeConfirmation: Math.round(volumeConfirmation),
    dataQuality: insufficient ? 'insufficient_history' : 'ok',
    reasoning
  };
}

module.exports = { analyze };
