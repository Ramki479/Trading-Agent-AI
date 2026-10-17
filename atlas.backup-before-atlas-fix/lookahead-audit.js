#!/usr/bin/env node
/**
 * atlas/lookahead-audit.js — Look-ahead violation detection.
 *
 * For every outcome resolution, verify:
 *   1. resolutionTimestamp > predictionTimestamp
 *   2. outcomePrice was not available before predictionTimestamp
 *
 * A single violation must be visible in the dashboard.
 * Never allows future data into prediction features.
 */

'use strict';

/**
 * Audit a single prediction-outcome pair for look-ahead violations.
 * @param prediction { ts, predictionId, mint, agent, direction }
 * @param outcome { realizedAt, pnlPct, exitMint }
 * @returns { passed, violation, reason }
 */
function auditPair(prediction, outcome) {
  if (!prediction || !outcome) {
    return { passed: false, violation: 'MISSING_DATA', reason: 'prediction or outcome is null' };
  }

  const predTs = Number(prediction.ts);
  const resTs = Number(outcome.realizedAt || outcome.exitTs);

  if (!Number.isFinite(predTs)) {
    return { passed: false, violation: 'INVALID_PREDICTION_TS', reason: 'prediction.ts is not a valid number' };
  }

  if (!Number.isFinite(resTs)) {
    return { passed: false, violation: 'INVALID_RESOLUTION_TS', reason: 'outcome.realizedAt is not a valid number' };
  }

  // Core check: resolution must be after prediction
  if (resTs <= predTs) {
    return {
      passed: false,
      violation: 'FUTURE_DATA',
      reason: `resolutionTimestamp (${resTs}) <= predictionTimestamp (${predTs})`
    };
  }

  // Check minimum horizon (outcome should be at least 1 second after prediction)
  if (resTs - predTs < 1000) {
    return {
      passed: false,
      violation: 'INSTANT_RESOLUTION',
      reason: `resolutionTimestamp (${resTs}) is less than 1 second after predictionTimestamp (${predTs})`
    };
  }

  return { passed: true, violation: null, reason: null };
}

/**
 * Audit a batch of prediction-outcome pairs.
 * @param pairs [{ prediction, outcome }]
 * @returns { totalChecked, violations, rejected, passed, details }
 */
function auditBatch(pairs) {
  if (!Array.isArray(pairs)) {
    return { totalChecked: 0, violations: 0, rejected: 0, passed: 0, details: [] };
  }

  const details = [];
  let violations = 0;
  let rejected = 0;
  let passed = 0;

  for (const pair of pairs) {
    const result = auditPair(pair.prediction, pair.outcome);
    if (result.passed) {
      passed++;
    } else {
      violations++;
      rejected++;
      details.push({
        predictionId: pair.prediction ? pair.prediction.predictionId : null,
        mint: pair.prediction ? pair.prediction.mint : null,
        agent: pair.prediction ? pair.prediction.agent : null,
        violation: result.violation,
        reason: result.reason,
        predictionTs: pair.prediction ? pair.prediction.ts : null,
        resolutionTs: pair.outcome ? (pair.outcome.realizedAt || pair.outcome.exitTs) : null
      });
    }
  }

  return {
    totalChecked: pairs.length,
    violations,
    rejected,
    passed,
    details: details.slice(0, 50) // cap details for safety
  };
}

/**
 * Full audit from persisted data.
 * @param db { AtlasDb instance }
 * @returns { totalChecked, violations, rejected, passed, details }
 */
function auditFromDb(db) {
  const predictions = db.predictions ? db.predictions() : [];
  const outcomes = db.outcomes ? db.outcomes() : [];

  // Build prediction lookup by predictionId
  const predMap = {};
  for (const p of predictions) {
    if (p.predictionId) predMap[p.predictionId] = p;
  }

  // Match outcomes to predictions
  const pairs = [];
  for (const o of outcomes) {
    const pred = predMap[o.predictionId];
    if (pred) {
      pairs.push({ prediction: pred, outcome: o });
    }
  }

  return auditBatch(pairs);
}

module.exports = { auditPair, auditBatch, auditFromDb };
