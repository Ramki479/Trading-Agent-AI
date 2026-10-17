#!/usr/bin/env node
/**
 * atlas/attribution.js — trade outcome classification + attribution.
 *
 * After every closed trade, classify the outcome and attribute it to one or more
 * of: GOOD_ENTRY_GOOD_EXIT, GOOD_ENTRY_BAD_EXIT, BAD_ENTRY, DATA_PROBLEM,
 * MARKET_REGIME_FAILURE, LIQUIDITY_FAILURE, MOMENTUM_FAILURE, MANIPULATION,
 * UNKNOWN.
 *
 * This is the system's learning dataset. It answers: did V1 fail, did ATLAS fail,
 * did data fail, did regime change, did liquidity collapse, did momentum reverse,
 * did the prediction fail, did price-integrity reject an anomaly?
 */

'use strict';

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));

const OUTCOME_CLASSES = [
  'GOOD_ENTRY_GOOD_EXIT',
  'GOOD_ENTRY_BAD_EXIT',
  'BAD_ENTRY',
  'DATA_PROBLEM',
  'MARKET_REGIME_FAILURE',
  'LIQUIDITY_FAILURE',
  'MOMENTUM_FAILURE',
  'MANIPULATION',
  'UNKNOWN'
];

/**
 * ATLAS vs Circuit attribution categories.
 * These classify whether ATLAS added value to the trade outcome.
 */
const ATLAS_ATTRIBUTION_CLASSES = [
  'TA_CORRECT_HELPED',
  'TA_CORRECT_BUT_IRRELEVANT',
  'TA_WRONG_BUT_CIRCUIT_SAVED',
  'TA_WRONG_AND_HARMFUL',
  'CIRCUIT_CORRECT_TA_DISAGREED',
  'BOTH_CORRECT',
  'BOTH_WRONG',
  'NO_ATLAS_DATA',
  'UNKNOWN'
];

/**
 * Classify a closed trade outcome.
 * @param trade { side, mint, symbol, entryTs, exitTs, entryPriceUsd?, entryPriceSol?, exitPriceUsd?, exitPriceSol?, realizedPnlPct, realizedPnlSol, exitReason, score, change1hPct?, recovery5mPct?, liquidityUsd?, volume24hUsd? }
 * @param atlas { researchScore, researchRecommendation, consensus, riskLevel, dataQuality, bullScore, bearRisk }
 * @param integrity { dataQuality?, pairStable?, sourcesAgree?, reasons? }
 * @returns { classification, factors, attribution, winningFactors, losingFactors, unexpectedEvents }
 */
function classify(trade, atlas, integrity, opts = {}) {
  if (!trade || !trade.side) return { classification: 'UNKNOWN', factors: {}, attribution: 'UNKNOWN', winningFactors: [], losingFactors: [], unexpectedEvents: [] };

  const pnlPct = Number.isFinite(trade.realizedPnlPct) ? trade.realizedPnlPct : 0;
  const won = pnlPct > 0;
  const reason = trade.exitReason || 'unknown';
  const v1Score = Number.isFinite(trade.score) ? trade.score : 60;
  const researchScore = Number.isFinite(atlas && atlas.researchScore) ? atlas.researchScore : 0;
  const researchRec = (atlas && atlas.researchRecommendation) || 'HOLD';
  const dataQuality = atlas ? (atlas.dataQuality || 'ok') : 'ok';
  const integrityDq = integrity ? (integrity.dataQuality || 'ok') : 'ok';
  const pairStable = integrity ? (integrity.pairStable != null ? integrity.pairStable : true) : true;
  const sourcesAgree = integrity ? (integrity.sourcesAgree != null ? integrity.sourcesAgree : true) : true;
  const reasonsI = integrity ? (integrity.reasons || []) : [];
  const regime = (opts.regime && opts.regime.regime) || null;
  const liquidityUsd = Number.isFinite(trade.liquidityUsd) ? trade.liquidityUsd : (opts.liquidityUsd != null ? opts.liquidityUsd : 0);
  const volume24hUsd = Number.isFinite(trade.volume24hUsd) ? trade.volume24hUsd : (opts.volume24hUsd != null ? opts.volume24hUsd : 0);
  const change1hPct = Number.isFinite(trade.change1hPct) ? trade.change1hPct : (opts.change1hPct != null ? opts.change1hPct : 0);
  const recovery5m = Number.isFinite(trade.recovery5mPct) ? trade.recovery5mPct : (opts.recovery5mPct != null ? opts.recovery5mPct : 0);
  const volatilityPct = Number.isFinite(trade.volatilityPct) ? trade.volatilityPct : (opts.volatilityPct != null ? opts.volatilityPct : 0);

  const winningFactors = [];
  const losingFactors = [];
  const unexpectedEvents = [];
  const factors = {};

  // Data problem
  if (dataQuality === 'suspicious' || dataQuality === 'fail' || dataQuality === 'quarantined' || integrityDq === 'suspicious' || integrityDq === 'fail') {
    if (reasonsI.some(r => /PAIR_CHANGED/i.test(r))) {
      factors.DATA_PROBLEM = true;
      losingFactors.push('PRICE_INTEGRITY: pair changed — observation identity invalid');
      unexpectedEvents.push('pair_change_detected');
    } else if (reasonsI.some(r => /EXTREME_PRICE_MOVE|price_discrepancy|suspicious/i.test(r))) {
      factors.DATA_PROBLEM = true;
      losingFactors.push('PRICE_INTEGRITY: suspicious price observation quarantined');
      unexpectedEvents.push('suspicious_price_observation');
    } else if (reasonsI.some(r => /STALE|stale/i.test(r))) {
      factors.DATA_PROBLEM = true;
      losingFactors.push('PRICE_INTEGRITY: stale price rejected by freshness policy');
    } else if (reasonsI.some(r => /invalid price|price unavailable/i.test(r))) {
      factors.DATA_PROBLEM = true;
      losingFactors.push('PRICE_INTEGRITY: invalid price rejected');
    }
  }

  // Regime failure
  if (won && (change1hPct < -20 || regime === 'DUMP' || regime === 'TREND_DOWN')) {
    losingFactors.push('MARKET_REGIME: larger trend still down despite trade win');
    factors.MARKET_REGIME_FAILURE = true;
  }
  if (!won && (change1hPct < -20 || regime === 'DUMP' || regime === 'TREND_DOWN')) {
    losingFactors.push('MARKET_REGIME: downtrend/dump regime — V1 stop-loss or momentum failure');
    factors.MARKET_REGIME_FAILURE = true;
  }

  // Liquidity failure
  if (liquidityUsd < 50000 || volume24hUsd < 100000) {
    if (!won) {
      losingFactors.push('LIQUIDITY: thin liquidity/volume limited exit quality');
      factors.LIQUIDITY_FAILURE = true;
    } else {
      factors.LIQUIDITY_FAILURE = false;
    }
  } else {
    factors.LIQUIDITY_FAILURE = false;
  }

  // Momentum failure
  if (!won && recovery5m < 0.25) {
    losingFactors.push('MOMENTUM: weak 5m recovery — dip not reversing');
    factors.MOMENTUM_FAILURE = true;
  }
  if (!won && volatilityPct >= 90) {
    losingFactors.push('MOMENTUM: extreme volatility — momentum thesis unreliable');
    factors.MOMENTUM_FAILURE = true;
  }
  if (won && recovery5m < 0.25) {
    losingFactors.push('MOMENTUM: win despite weak recovery — may be noise/recovery failure');
  }

  // Manipulation
  if (reasonsI.some(r => /SOURCE_DIVERGENCE|source_divergence|divergence/i.test(r)) || (atlas && atlas.dataQuality === 'suspicious')) {
    factors.MANIPULATION = true;
    losingFactors.push('DATA: source divergence or suspicious data — possible manipulation');
    unexpectedEvents.push('source_divergence_detected');
  } else {
    factors.MANIPULATION = false;
  }
  if (reasonsI.some(r => /PAIR_CHANGED/i.test(r))) {
    factors.MANIPULATION = true;
  }

  // V1 attribution
  factors.V1 = {
    score: v1Score,
    reason,
    won
  };
  if (reason === 'take-profit' && won) {
    winningFactors.push('V1: take-profit executed as designed');
  } else if (reason === 'stop-loss' && !won) {
    losingFactors.push('V1: stop-loss executed as designed (risk control working, not failure)');
    winningFactors.push('V1: stop-loss limit -6% protected against larger loss');
  } else if (reason === 'recovery_exit') {
    winningFactors.push('V1: recovery exit executed');
  }

  // ATLAS attribution
  if (atlas) {
    factors.ATLAS = {
      researchScore,
      researchRecommendation: researchRec,
      consensus: atlas.consensus || 'mixed',
      riskLevel: atlas.riskLevel || 'medium',
      dataQuality: atlas.dataQuality || 'ok'
    };
    if (researchRec === 'BUY' && won) winningFactors.push('ATLAS: research recommended BUY and trade won');
    else if (researchRec === 'AVOID' && !won) winningFactors.push('ATLAS: research recommended AVOID and trade lost (correct avoidance)');
    else if (researchRec === 'AVOID' && won) losingFactors.push('ATLAS: research recommended AVOID but trade won (avoidance was wrong)');
    else if (researchRec === 'BUY' && !won) losingFactors.push('ATLAS: research recommended BUY but trade lost (prediction failure)');
  }

  // Classification
  let classification = 'UNKNOWN';

  if (factors.DATA_PROBLEM) {
    classification = 'DATA_PROBLEM';
  } else if (factors.MARKET_REGIME_FAILURE && !won && (change1hPct < -20 || regime === 'DUMP')) {
    classification = 'MARKET_REGIME_FAILURE';
  } else if (factors.LIQUIDITY_FAILURE && !won && liquidityUsd < 50000) {
    classification = 'LIQUIDITY_FAILURE';
  } else if (factors.MOMENTUM_FAILURE && !won && recovery5m < 0.25) {
    classification = 'MOMENTUM_FAILURE';
  } else if (factors.MANIPULATION) {
    classification = 'MANIPULATION';
  } else if (won && reason === 'take-profit') {
    classification = 'GOOD_ENTRY_GOOD_EXIT';
  } else if (!won && reason === 'stop-loss') {
    classification = 'GOOD_ENTRY_BAD_EXIT'; // entry was acceptable; exit was the safety mechanism
  } else if (!won && reason === 'stop-loss' && v1Score < 60) {
    classification = 'BAD_ENTRY';
  } else if (won && reason === 'stop-loss') {
    classification = 'GOOD_ENTRY_GOOD_EXIT'; // stop-loss reversed upside (rare, but win)
  } else {
    classification = 'UNKNOWN';
  }

  // Second-pass override for data problems
  if (factors.DATA_PROBLEM) classification = 'DATA_PROBLEM';
  if (factors.MARKET_REGIME_FAILURE) classification = 'MARKET_REGIME_FAILURE';
  if (factors.LIQUIDITY_FAILURE) classification = 'LIQUIDITY_FAILURE';
  if (factors.MOMENTUM_FAILURE) classification = 'MOMENTUM_FAILURE';
  if (factors.MANIPULATION) classification = 'MANIPULATION';

  let attribution = classification;

  return {
    classification,
    attribution,
    factors,
    winningFactors,
    losingFactors,
    unexpectedEvents,
    v1: factors.V1,
    atlas: factors.ATLAS,
    dataProblem: !!factors.DATA_PROBLEM,
    regimeFailure: !!factors.MARKET_REGIME_FAILURE,
    liquidityFailure: !!factors.LIQUIDITY_FAILURE,
    momentumFailure: !!factors.MOMENTUM_FAILURE,
    manipulation: !!factors.MANIPULATION
  };
}

/**
 * Classify ATLAS vs Circuit contribution for a closed trade.
 * @param circuitDecision { direction: 'bullish'|'bearish'|'neutral', decision: 'BUY'|'SELL'|'HOLD' }
 * @param atlasRecommendation { direction: 'bullish'|'bearish'|'neutral', recommendation: 'BUY'|'AVOID'|'HOLD' }
 * @param outcome { won: boolean, pnlPct: number }
 */
function classifyAtlas(circuitDecision, atlasRecommendation, outcome) {
  if (!outcome) return 'UNKNOWN';
  const won = outcome.won || outcome.pnlPct > 0;
  const circuitBullish = (circuitDecision && circuitDecision.direction === 'bullish') || (circuitDecision && circuitDecision.decision === 'BUY');
  const atlasBullish = (atlasRecommendation && atlasRecommendation.direction === 'bullish') || (atlasRecommendation && atlasRecommendation.recommendation === 'BUY');
  const atlasBearish = (atlasRecommendation && atlasRecommendation.direction === 'bearish') || (atlasRecommendation && atlasRecommendation.recommendation === 'AVOID');
  const atlasNeutral = (atlasRecommendation && atlasRecommendation.recommendation === 'HOLD') || (atlasRecommendation && atlasRecommendation.direction === 'neutral');

  // No ATLAS data
  if (!atlasRecommendation || atlasRecommendation.unavailable || !atlasRecommendation.recommendation) {
    return 'NO_ATLAS_DATA';
  }

  // TA agreed (BUY) and trade won
  if (atlasBullish && won) {
    return 'TA_CORRECT_HELPED';
  }

  // TA agreed (BUY) but trade lost, circuit also agreed
  if (atlasBullish && !won && circuitBullish) {
    return 'TA_WRONG_AND_HARMFUL';
  }

  // TA was neutral/HOLD — irrelevant to direction (check before bearish)
  if (atlasNeutral) {
    return 'TA_CORRECT_BUT_IRRELEVANT';
  }

  // TA was bearish/avoid, trade won (TA wrong)
  if (atlasBearish && won) {
    return 'TA_WRONG_BUT_CIRCUIT_SAVED';
  }

  // TA was bearish/avoid, trade lost (TA was correct)
  if (atlasBearish && !won) {
    return 'TA_CORRECT_HELPED';
  }

  // Circuit agreed and correct, TA also agreed
  if (circuitBullish && won && atlasBullish) {
    return 'BOTH_CORRECT';
  }

  // Both wrong
  if (circuitBullish && !won && atlasBullish) {
    return 'BOTH_WRONG';
  }

  return 'UNKNOWN';
}

module.exports = { classify, classifyAtlas, OUTCOME_CLASSES, ATLAS_ATTRIBUTION_CLASSES, clamp };
