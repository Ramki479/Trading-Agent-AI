#!/usr/bin/env node
/**
 * atlas/agents/token-quality.js — ATLAS Token Quality Agent.
 *
 * Scores:
 *   - liquidity quality
 *   - volume quality
 *   - token age
 *   - trading consistency
 *   - market-data quality
 *   - pair stability
 *   - price-source consistency
 *
 * This agent pays special attention to the previously observed type of anomaly where
 * a token price could appear to move from approximately ₹5,605 to approximately ₹2.
 * A symbol is NOT identity. Canonical identity must use mint + pairAddress + dex.
 * If identity changes unexpectedly -> REJECT.
 */

'use strict';

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));

function analyze(input = {}) {
  const cand = input.candidate || {};
  const integrity = input.integrity || {};
  const history = input.history || {};
  const dq = integrity.dataQuality === 'suspicious' || integrity.dataQuality === 'fail' ? 0 : 100;

  const liquidityUsd = Number.isFinite(cand.liquidityUsd) ? cand.liquidityUsd : 0;
  const volume24hUsd = Number.isFinite(cand.volume24hUsd) ? cand.volume24hUsd : 0;
  const volumeUsd = Number.isFinite(cand.volumeUsd) ? cand.volumeUsd : volume24hUsd;
  const tokenAgeDays = Number.isFinite(cand.tokenAgeDays) ? cand.tokenAgeDays : null;
  const buysPct = Number.isFinite(cand.buysPct) ? cand.buysPct : null;
  const transactionCount = Number.isFinite(cand.transactionCount) ? cand.transactionCount : null;
  const tradesCount = Number.isFinite(cand.tradesCount) ? cand.tradesCount : null;
  const mvRatio = Number.isFinite(cand.mvRatio) ? cand.mvRatio : null; // marketcap / volume ratio
  const priceSource = cand.priceSource || null;
  const pairAddress = cand.pairAddress || null;
  const dex = cand.dex || null;
  const mint = cand.mint || null;

  // ZCAT-type anomaly checks
  const suspiciousPriceMove = integrity.suspiciousPriceMove === true;
  const pairChanged = integrity.pairChanged === true;
  const sourceDivergence = integrity.sourceDivergence === true;
  const stalePrice = integrity.stalePrice === true;
  const invalidPrice = integrity.invalidPrice === true;

  let direction = 'neutral';
  let reason = 'insufficient data';
  let confidence = 0;
  let score = 0;
  let status = 'NO_DATA';
  let tokenQualityScore = 0;
  let pairStable = true;
  let sourcesAgree = true;
  let lq = 0, vq = 0, ta = 0, tc = 0, md = 0, ps = 0;

  const evidence = [];
  const risks = [];
  const invalidatingConditions = [];

  // Identity checks
  if (mint == null) {
    risks.push('missing_mint_identity');
    invalidatingConditions.push('mint identity missing — cannot assess token quality');
  } else {
    evidence.push({ claim: 'mint identity', value: mint, source: 'candidate_metadata', confidence: clamp(90), timestamp: Date.now(), sourceDetail: 'mint' });
  }
  if (pairAddress != null) {
    evidence.push({ claim: 'pair address', value: pairAddress, source: 'candidate_metadata', confidence: clamp(85), timestamp: Date.now(), sourceDetail: 'pair_address' });
  } else {
    risks.push('missing_pair_address');
    invalidatingConditions.push('pairAddress missing — identity incomplete');
  }
  if (dex != null) {
    evidence.push({ claim: 'dex', value: dex, source: 'candidate_metadata', confidence: clamp(85), timestamp: Date.now(), sourceDetail: 'dex' });
  } else {
    risks.push('missing_dex');
  }

  // Pair stability
  if (pairChanged) {
    pairStable = false;
    evidence.push({ claim: 'pair change detected', value: 'PAIR_CHANGED', source: 'price_integrity', confidence: clamp(90), timestamp: Date.now(), sourceDetail: 'pair_changed' });
    risks.push('pair_changed');
    invalidatingConditions.push('pair identity changed — new pair price must not be used for this position/mint');
  }
  if (pairAddress != null && integrity.lastPairAddress != null && integrity.lastPairAddress !== pairAddress) {
    pairStable = false;
    evidence.push({ claim: 'pair address mismatch', value: 'last=' + integrity.lastPairAddress + ' current=' + pairAddress, source: 'price_integrity', confidence: clamp(90), timestamp: Date.now(), sourceDetail: 'pair_mismatch' });
    risks.push('pair_mismatch');
  }

  // Source agreement
  if (sourceDivergence) {
    sourcesAgree = false;
    evidence.push({ claim: 'source divergence', value: 'CIRCUIT != DEXSCREENER beyond threshold', source: 'price_integrity', confidence: clamp(85), timestamp: Date.now(), sourceDetail: 'source_divergence' });
    risks.push('source_divergence');
  }

  // Price anomaly checks
  if (suspiciousPriceMove) {
    evidence.push({ claim: 'suspicious price move', value: 'EXTREME_PRICE_DISCREPANCY quarantined', source: 'price_integrity', confidence: clamp(90), timestamp: Date.now(), sourceDetail: 'suspicious_move' });
    risks.push('suspicious_price_move');
    invalidatingConditions.push('suspicious price observation — must not be used for trading/accounting');
  }
  if (stalePrice) {
    evidence.push({ claim: 'stale price', value: 'STALE (outside freshness policy)', source: 'price_integrity', confidence: clamp(85), timestamp: Date.now(), sourceDetail: 'stale_price' });
    risks.push('stale_price');
    invalidatingConditions.push('stale price — rejected by freshness policy');
  }
  if (invalidPrice) {
    evidence.push({ claim: 'invalid price', value: 'price unavailable/invalid', source: 'price_integrity', confidence: clamp(90), timestamp: Date.now(), sourceDetail: 'invalid_price' });
    risks.push('invalid_price');
    invalidatingConditions.push('invalid price — rejected');
  }

  // Data quality
  if (dq === 0) {
    direction = 'unknown';
    reason = 'price-integrity flagged data as invalid/quarantined';
    status = 'FAIL';
    pairStable = false;
    sourcesAgree = false;
  } else if (liquidityUsd <= 0 && volume24hUsd <= 0) {
    direction = 'unknown';
    reason = 'no liquidity or volume data';
    status = 'NO_DATA';
  } else {
    status = 'PARTIAL';

    lq = 0; // liquidity quality
    vq = 0; // volume quality
    ta = 0; // token age
    tc = 0; // trading consistency
    md = 0; // market-data quality
    ps = 0; // price-source consistency

    // liquidity quality
    if (liquidityUsd > 0) {
      if (liquidityUsd >= 1000000) lq = 90;
      else if (liquidityUsd >= 500000) lq = 80;
      else if (liquidityUsd >= 100000) lq = 65;
      else if (liquidityUsd >= 10000) lq = 45;
      else if (liquidityUsd >= 1000) lq = 25;
      else lq = 10;
      evidence.push({ claim: 'liquidity quality', value: '$' + Math.round(liquidityUsd).toLocaleString() + ' depth → score ' + lq, source: 'candidate_metadata', confidence: clamp(50 + lq * 0.5), timestamp: Date.now(), sourceDetail: 'liquidity_quality' });
    }

    // volume quality
    if (volume24hUsd > 0) {
      if (volume24hUsd >= 5000000) vq = 90;
      else if (volume24hUsd >= 1000000) vq = 80;
      else if (volume24hUsd >= 200000) vq = 65;
      else if (volume24hUsd >= 50000) vq = 45;
      else if (volume24hUsd >= 10000) vq = 25;
      else vq = 10;
      evidence.push({ claim: 'volume quality', value: '$' + Math.round(volume24hUsd).toLocaleString() + ' 24h → score ' + vq, source: 'candidate_metadata', confidence: clamp(50 + vq * 0.5), timestamp: Date.now(), sourceDetail: 'volume_quality' });
    }

    // token age
    if (tokenAgeDays != null && tokenAgeDays > 0) {
      if (tokenAgeDays >= 365) ta = 90;
      else if (tokenAgeDays >= 90) ta = 75;
      else if (tokenAgeDays >= 30) ta = 60;
      else if (tokenAgeDays >= 7) ta = 40;
      else if (tokenAgeDays >= 1) ta = 20;
      else ta = 5;
      evidence.push({ claim: 'token age', value: tokenAgeDays.toFixed(0) + ' days → score ' + ta, source: 'on_chain_data', confidence: clamp(40 + ta * 0.5), timestamp: Date.now(), sourceDetail: 'token_age' });
    }

    // trading consistency
    if (buysPct != null && transactionCount != null && transactionCount > 0) {
      const imbalance = Math.abs(buysPct - 50);
      if (imbalance > 30) tc = clamp(100 - imbalance * 2);
      else if (imbalance > 15) tc = clamp(85 - (imbalance - 15) * 1.3);
      else tc = clamp(70 + (15 - imbalance) * 1);
      evidence.push({ claim: 'trading consistency', value: buysPct.toFixed(0) + '% buys, imbalance ' + imbalance.toFixed(0) + 'pp → score ' + tc, source: 'on_chain_data', confidence: clamp(45 + tc * 0.5), timestamp: Date.now(), sourceDetail: 'trading_consistency' });
      if (imbalance > 30) risks.push('trading_imbalance');
    }

    // market-data quality
    md = 50;
    if (priceSource) md += 10;
    if (pairStable) md += 15;
    if (sourcesAgree) md += 15;
    if (liquidityUsd > 0 && volume24hUsd > 0) md += 10;
    md = clamp(md);
    evidence.push({ claim: 'market-data quality', value: 'sources: ' + (priceSource || 'unknown') + ', pair: ' + (pairStable ? 'stable' : 'changed') + ', sources agree: ' + (sourcesAgree ? 'yes' : 'no') + ' → score ' + md, source: 'price_integrity', confidence: clamp(50 + md * 0.5), timestamp: Date.now(), sourceDetail: 'market_data_quality' });

    // price-source consistency
    if (priceSource) {
      ps = 60;
      if (sourcesAgree) ps += 20;
      if (!pairChanged && pairStable) ps += 10;
      ps = clamp(ps);
    } else {
      ps = 20;
    }
    evidence.push({ claim: 'price-source consistency', value: 'source: ' + (priceSource || 'unknown') + ', agree: ' + sourcesAgree + ' → score ' + ps, source: 'price_integrity', confidence: clamp(50 + ps * 0.5), timestamp: Date.now(), sourceDetail: 'price_source_consistency' });

    // combine
    const raw = (lq + vq + ta + tc + md + ps) / 6;
    tokenQualityScore = clamp(Math.round(raw));
    score = clamp(Math.round(raw));

    // direction
    if (suspiciousPriceMove || pairChanged || invalidPrice) {
      direction = 'bearish';
      reason = 'token-quality flags data-integrity problems — MUST NOT trade on this observation';
      confidence = clamp(60);
    } else if (tokenQualityScore >= 70 && liquidityUsd >= 100000) {
      direction = 'bullish';
      reason = 'token quality is solid — sufficient liquidity, stable pair, consistent data';
      confidence = clamp(40 + tokenQualityScore * 0.4);
    } else if (tokenQualityScore >= 40) {
      direction = 'neutral';
      reason = 'token quality moderate — ' + tokenQualityScore + '/100';
      confidence = clamp(25 + tokenQualityScore * 0.5);
    } else {
      direction = 'bearish';
      reason = 'token quality weak — ' + tokenQualityScore + '/100 (low liquidity/volume/age/data quality)';
      confidence = clamp(30 + (100 - tokenQualityScore) * 0.2);
    }
    confidence = clamp(confidence);
    score = clamp(Math.round(confidence));
  }

  return {
    agent: 'token-quality',
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
    prediction: predictionObj(direction, score, tokenQualityScore),
    dataQuality: dq > 0 ? 'ok' : integrity.dataQuality || 'ok',
    status,
    tokenQualityScore,
    pairStable,
    sourcesAgree,
    qualityComponents: { liquidityQuality: lq, volumeQuality: vq, tokenAge: ta, tradingConsistency: tc, marketDataQuality: md, priceSourceConsistency: ps }
  };

  function predictionObj(direction, score, tq) {
    if (direction === 'unknown') return { expectedMovePct: 0, probabilityUp: 0, probabilityDown: 0 };
    const base = clamp(score / 100);
    const up = direction === 'bullish' ? base : (direction === 'bearish' ? 1 - base : 0.5);
    const down = direction === 'bearish' ? base : (direction === 'bullish' ? 1 - base : 0.5);
    const tqBias = tq >= 70 ? 5 : (tq >= 40 ? 0 : -10);
    const expected = (direction === 'bullish' ? 1 : -1) * clamp(score / 15) + tqBias;
    return {
      expectedMovePct: Math.round(clamp(expected, -50, 50)),
      probabilityUp: clamp(up),
      probabilityDown: clamp(down)
    };
  }
}

module.exports = { analyze };
