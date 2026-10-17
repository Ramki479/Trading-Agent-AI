#!/usr/bin/env node
/**
 * atlas/agents/sentiment.js — ATLAS Sentiment Agent.
 *
 * Builds sentiment signals ONLY from actually available data: market activity,
 * buy/sell imbalance, volume acceleration, token metadata, SOL market condition,
 * available news/social signals.
 *
 * If no reliable sentiment data exists -> status: NO_DATA, direction: unknown,
 * confidence: 0.
 *
 * NEVER fabricates news, social sentiment, token announcements, or market statistics.
 */

'use strict';

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));

function analyze(input = {}) {
  const cand = input.candidate || {};
  const market = input.market || {};
  const integrity = input.integrity || {};
  const universe = input.universe || {};
  const dq = integrity.dataQuality === 'suspicious' || integrity.dataQuality === 'fail' ? 0 : 100;

  const change5mPct = Number.isFinite(cand.change5mPct) ? cand.change5mPct : null;
  const change1hPct = Number.isFinite(cand.change1hPct) ? cand.change1hPct : null;
  const volume24hUsd = Number.isFinite(cand.volume24hUsd) ? cand.volume24hUsd : 0;
  const liquidityUsd = Number.isFinite(cand.liquidityUsd) ? cand.liquidityUsd : 0;
  const buysPct = Number.isFinite(cand.buysPct) ? cand.buysPct : null;
  const transactionCount = Number.isFinite(cand.transactionCount) ? cand.transactionCount : null;
  const solPriceUsd = Number.isFinite(market.solPriceUsd) ? market.solPriceUsd : null;
  const solMomentumPct = Number.isFinite(market.solMomentumPct) ? market.solMomentumPct : null;
  const healthScore = Number.isFinite(market.healthScore) ? market.healthScore : null;
  const regime = market.regime || null;
  const avgVolumeUsd = Number.isFinite(universe.avgVolumeUsd) ? universe.avgVolumeUsd : null;

  const externalSentimentAvailable = cand.externalSentimentAvailable === true && cand.externalSentiment != null;
  const newsAvailable = cand.newsAvailable === true && Array.isArray(cand.news) && cand.news.length > 0;

  let direction = 'unknown';
  let reason = 'no reliable sentiment data';
  let confidence = 0;
  let score = 0;
  let status = 'NO_DATA';
  let sentimentScore = 0;

  const evidence = [];
  const risks = [];
  const invalidatingConditions = [];

  if (dq === 0) {
    direction = 'unknown';
    reason = 'price-integrity flagged data as invalid/quarantined';
    status = 'NO_DATA';
  } else if (externalSentimentAvailable) {
    direction = normalizeDirection(cand.externalSentiment.direction || 'unknown');
    confidence = clamp(cand.externalSentiment.confidence != null ? cand.externalSentiment.confidence : 0);
    score = clamp(Math.round(confidence));
    status = 'EXTERNAL';
    reason = 'external sentiment available (source=' + (cand.externalSentiment.source || 'unknown') + ')';
    evidence.push({ claim: 'external sentiment', value: direction, source: cand.externalSentiment.source || 'external', confidence: clamp(cand.externalSentiment.confidence || 0), timestamp: cand.externalSentiment.timestamp || Date.now(), sourceDetail: 'external_sentiment' });
  } else if (newsAvailable) {
    const bullishNews = cand.news.some(n => n.sentiment === 'bullish');
    const bearishNews = cand.news.some(n => n.sentiment === 'bearish');
    if (bullishNews && !bearishNews) {
      direction = 'bullish';
      confidence = clamp(40 + cand.news.length * 5);
      reason = cand.news.length + ' bullish news items (source=' + (cand.newsSource || 'unknown') + ')';
      status = 'NEWS';
    } else if (bearishNews && !bullishNews) {
      direction = 'bearish';
      confidence = clamp(40 + cand.news.length * 5);
      reason = cand.news.length + ' bearish news items (source=' + (cand.newsSource || 'unknown') + ')';
      status = 'NEWS';
    } else {
      direction = 'neutral';
      confidence = clamp(30 + cand.news.length * 3);
      reason = cand.news.length + ' news items, mixed signals (source=' + (cand.newsSource || 'unknown') + ')';
      status = 'NEWS';
    }
    score = clamp(Math.round(confidence));
    confidence = clamp(confidence);
    cand.news.forEach((n, i) => {
      evidence.push({
        claim: 'news item ' + (i + 1),
        value: n.headline || 'headline',
        source: cand.newsSource || 'news',
        confidence: clamp(n.confidence || 0),
        timestamp: n.timestamp || Date.now(),
        sourceDetail: 'news'
      });
    });
  } else {
    const volAccel = computeVolumeAcceleration(avgVolumeUsd, volume24hUsd, cand.volumeAccelerationPct);
    const buySellImbalance = buysPct != null ? (buysPct - 50) / 50 : 0;
    const activitySignal = computeActivitySignal(transactionCount, volume24hUsd, liquidityUsd);
    const momentumSignal = computeMomentumSignal(change5mPct, change1hPct);
    const solSignal = computeSolSignal(solMomentumPct, regime);

    sentimentScore = computeSentimentFromSignals(volAccel, buySellImbalance, activitySignal, momentumSignal, solSignal, cand.tokenMetadata);
    direction = sentimentDirection(sentimentScore);
    confidence = clamp(sentimentConfidence(sentimentScore, volAccel, buySellImbalance, activitySignal, cand.volumeAccelerationPct));
    score = clamp(Math.round(confidence));
    if (confidence > 0) {
      status = 'DERIVED';
      reason = 'derived from real activity/volume/momentum signals (no external sentiment or news available)';
    } else {
      status = 'NO_DATA';
      reason = 'no reliable sentiment, activity, or external data to derive sentiment';
    }
    if (volAccel !== 0) evidence.push({ claim: 'volume acceleration', value: volAccel.toFixed(2) + ' (vs avg volume)', source: 'universe_average_volume', confidence: clamp(40 + Math.min(100, Math.abs(volAccel) * 10)), timestamp: Date.now(), sourceDetail: 'volume_acceleration' });
    if (buysPct != null) evidence.push({ claim: 'buy/sell imbalance', value: buysPct.toFixed(0) + '% buys', source: 'candidate_metadata', confidence: clamp(40 + Math.min(100, Math.abs(buysPct - 50) * 1.5)), timestamp: Date.now(), sourceDetail: 'buy_sell_imbalance' });
    if (transactionCount != null && transactionCount > 0) evidence.push({ claim: 'transaction activity', value: transactionCount.toLocaleString() + ' txns', source: 'candidate_metadata', confidence: clamp(40 + Math.min(100, transactionCount / 1000 * 20)), timestamp: Date.now(), sourceDetail: 'transaction_count' });
    if (change5mPct != null) evidence.push({ claim: '5m price momentum', value: change5mPct.toFixed(2) + '%', source: 'local_history', confidence: clamp(45 + Math.min(100, Math.abs(change5mPct) * 2)), timestamp: Date.now(), sourceDetail: '5m_momentum' });
    if (change1hPct != null) evidence.push({ claim: '1h price momentum', value: change1hPct.toFixed(1) + '%', source: 'local_history', confidence: clamp(40 + Math.min(100, Math.abs(change1hPct) * 1.5)), timestamp: Date.now(), sourceDetail: '1h_momentum' });
    if (solMomentumPct != null) evidence.push({ claim: 'SOL momentum', value: solMomentumPct.toFixed(1) + '%', source: 'market_context', confidence: clamp(35 + Math.min(100, Math.abs(solMomentumPct) * 1.5)), timestamp: Date.now(), sourceDetail: 'sol_momentum' });
    if (regime) evidence.push({ claim: 'market regime', value: regime, source: 'market_context', confidence: clamp(30 + Math.min(100, Math.abs(change1hPct || 0) * 0.5)), timestamp: Date.now(), sourceDetail: 'market_regime' });
    if (!status.startsWith('EXTERNAL') && !status.startsWith('NEWS')) {
      evidence.push({ claim: 'sentiment data availability', value: 'no external sentiment or news', source: 'atlas_sentiment_agent', confidence: clamp(30), timestamp: Date.now(), sourceDetail: 'no_external_sentiment' });
    }
  }

  if (dq === 0) {
    risks.push('data_integrity_failed');
  } else if (status === 'DERIVED' || status === 'NEWS' || status === 'EXTERNAL') {
    if (sentimentScore > 70 && volAccel > 1) risks.push('sentiment_overheating_risk');
    if (sentimentScore < -70 && volAccel < -1) risks.push('sentiment_selling_pressure');
    if (buysPct != null && buysPct > 80) risks.push('buying_imbalance');
  }

  return {
    agent: 'sentiment',
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
    prediction: predictionObj(direction, score, sentimentScore),
    dataQuality: dq > 0 ? 'ok' : integrity.dataQuality || 'ok',
    sentimentStatus: status,
    sentimentScore: Math.round(sentimentScore)
  };

  function normalizeDirection(d) {
    const set = new Set(['bullish', 'bearish', 'neutral', 'unknown']);
    return set.has(String(d)) ? String(d) : 'unknown';
  }

  function computeVolumeAcceleration(avgVolume, currentVolume, volAccelPct) {
    if (volAccelPct != null && Number.isFinite(volAccelPct)) return volAccelPct;
    if (avgVolume && avgVolume > 0 && currentVolume > 0) {
      return clamp(((currentVolume - avgVolume) / avgVolume) * 100, -100, 100);
    }
    return 0;
  }

  function computeActivitySignal(txCount, volume, liquidity) {
    if (txCount == null || txCount <= 0) return 0;
    const activity = txCount / Math.max(liquidity, volume, 1);
    return clamp(activity * 1000, -100, 100);
  }

  function computeMomentumSignal(c5m, c1h) {
    if (c5m != null && Number.isFinite(c5m)) return c5m;
    if (c1h != null && Number.isFinite(c1h)) return c1h / 12;
    return 0;
  }

  function computeSolSignal(solMomentum, regime) {
    if (solMomentum != null && Number.isFinite(solMomentum)) return clamp(solMomentum / 5, -20, 20);
    if (regime === 'TREND_UP') return 15;
    if (regime === 'TREND_DOWN' || regime === 'DUMP') return -15;
    return 0;
  }

  function computeSentimentFromSignals(volAccel, buySell, activity, momentum, sol, meta) {
    let s = 0;
    s += volAccel * 0.4;
    s += buySell * 20;
    s += activity * 2;
    s += momentum * 0.8;
    s += sol * 0.5;
    if (meta && meta.category) {
      if (meta.category === 'memecoin' || meta.category === 'speculative') s += 5;
      if (meta.category === 'defi' || meta.category === 'infrastructure') s += -3;
    }
    return clamp(s);
  }

  function sentimentDirection(score) {
    if (score > 15) return 'bullish';
    if (score < -15) return 'bearish';
    return 'neutral';
  }

  function sentimentConfidence(score, volAccel, buySell, activity, volAccelPct) {
    let base = 0;
    if (volAccel !== 0) base += Math.min(100, Math.abs(volAccel) * 0.8);
    if (buySell !== 0) base += Math.min(100, Math.abs(buySell) * 1.5);
    if (activity !== 0) base += Math.min(100, Math.abs(activity) * 1);
    if (volAccelPct != null && Math.abs(volAccelPct) > 20) base += 10;
    if (Math.abs(score) < 10) return 0;
    return clamp(base);
  }

  function predictionObj(direction, score, sentimentScore) {
    if (direction === 'unknown') return { expectedMovePct: 0, probabilityUp: 0, probabilityDown: 0 };
    const base = clamp(score / 100);
    const up = direction === 'bullish' ? base : (direction === 'bearish' ? 1 - base : 0.5);
    const down = direction === 'bearish' ? base : (direction === 'bullish' ? 1 - base : 0.5);
    const expected = (direction === 'bullish' ? 1 : -1) * clamp(score / 15) * Math.max(0, 1 + sentimentScore / 100);
    return {
      expectedMovePct: Math.round(clamp(expected, -50, 50)),
      probabilityUp: clamp(up),
      probabilityDown: clamp(down)
    };
  }
}

module.exports = { analyze };
