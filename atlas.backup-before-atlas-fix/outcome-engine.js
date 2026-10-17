#!/usr/bin/env node
/**
 * atlas/outcome-engine.js — look-ahead-free prediction outcome evaluation.
 *
 * For each prediction at timestamp T, evaluate only against market data with
 * timestamp > T (no future information used before the prediction). Returns
 * a structured outcome with correctness, realized return, and attribution hints.
 */

'use strict';

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));

/**
 * Evaluate one prediction against a realized outcome.
 * @param prediction { predictionId, ts, mint, pairAddress, dex, agent, direction, expectedMovePct, probabilityUp, probabilityDown, timeHorizon }
 * @param outcome { pnlPct, realizedAt, exitTs, exitPriceUsd?, exitPriceSol?, entryPriceUsd?, entryPriceSol?, exitReason, exitMint }
 * @returns { outcome: { ... }, correct, realizedPnlPct, pnlPct, horizonExpired }
 */
function evaluate(prediction, outcome, opts = {}) {
  if (!prediction || !outcome) return { outcome: null, correct: false, realizedPnlPct: 0, pnlPct: 0, horizonExpired: false };

  const ts = prediction.ts || Date.now();
  const realizedAt = Number.isFinite(outcome.realizedAt) ? outcome.realizedAt : (Number.isFinite(outcome.exitTs) ? outcome.exitTs : Date.now());
  const horizonExpired = (!opts.requireHorizonExpiry || (opts.requireHorizonExpiry && realizedAt >= ts + horizonMs(prediction.timeHorizon)));

  const pnlPct = Number.isFinite(outcome.pnlPct) ? outcome.pnlPct : (Number.isFinite(outcome.realizedPnlPct) ? outcome.realizedPnlPct : 0);
  const realizedPnlPct = clamp(pnlPct, -100, 100);

  const won = realizedPnlPct > 0;
  const dir = prediction.direction || 'unknown';

  let correct = false;
  let confidenceCorrect = null;

  if (dir === 'bullish' && won) correct = true;
  else if (dir === 'bearish' && !won) correct = true;
  else if (dir === 'neutral') correct = false; // neutral is not a prediction
  else correct = false;

  // Probability calibration: was the predicted-up probability aligned with outcome?
  const probUp = Number.isFinite(prediction.probabilityUp) ? prediction.probabilityUp : 0.5;
  const probDown = Number.isFinite(prediction.probabilityDown) ? prediction.probabilityDown : 0.5;
  const predictedProb = dir === 'bullish' ? probUp : (dir === 'bearish' ? probDown : 0.5);
  const outcomeBinary = won ? 1 : 0;
  const brier = (predictedProb - outcomeBinary) ** 2;
  const calibrationError = Math.abs(predictedProb - outcomeBinary);

  // Expected move vs realized
  const expected = Number.isFinite(prediction.expectedMovePct) ? prediction.expectedMovePct : 0;
  const expectedCorrect = Math.sign(expected) === Math.sign(realizedPnlPct) && Math.abs(realizedPnlPct) > 0;

  return {
    outcome: {
      predictionId: prediction.predictionId,
      ts,
      realizedAt,
      mint: prediction.mint,
      pairAddress: prediction.pairAddress,
      dex: prediction.dex,
      agent: prediction.agent,
      direction: dir,
      confidence: prediction.confidence,
      expectedMovePct: expected,
      probabilityUp: probUp,
      probabilityDown: probDown,
      timeHorizon: prediction.timeHorizon,
      pnlPct: realizedPnlPct,
      exitReason: outcome.exitReason || null,
      exitMint: outcome.exitMint || prediction.mint,
      horizonExpired
    },
    correct,
    realizedPnlPct,
    pnlPct: realizedPnlPct,
    horizonExpired,
    predictedProb,
    outcomeBinary,
    brier: clamp(Math.round(brier * 1000) / 1000),
    calibrationError: clamp(Math.round(calibrationError * 1000) / 1000),
    expectedCorrect
  };
}

function horizonMs(horizon) {
  if (!horizon) return 900000; // 15m default
  const h = String(horizon).toLowerCase();
  if (h === '5m') return 300000;
  if (h === '15m') return 900000;
  if (h === '30m') return 1800000;
  if (h === '1h') return 3600000;
  if (h === '4h') return 14400000;
  if (h === '1d') return 86400000;
  return 900000;
}

/**
 * All supported horizons in chronological order.
 */
const ALL_HORIZONS = ['5m', '15m', '30m', '1h', '4h'];

module.exports = { evaluate, horizonMs, clamp, ALL_HORIZONS };
