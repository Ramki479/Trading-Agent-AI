#!/usr/bin/env node
/**
 * atlas/calibration.js — Confidence calibration analysis.
 *
 * Evaluates whether prediction confidence corresponds to actual outcomes.
 * If an agent says 90% confidence and only 55% of those are correct,
 * the agent is badly calibrated.
 *
 * Confidence buckets: 50-59%, 60-69%, 70-79%, 80-89%, 90-100%
 * For each bucket: predictionCount, accuracy, averageReturn
 *
 * Calibration error: average absolute difference between confidence
 * midpoint and actual accuracy across all populated buckets.
 *
 * All calculations are deterministic and look-ahead-free.
 */

'use strict';

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));

const CONFIDENCE_BUCKETS = [
  { label: '50-59%', lo: 50, hi: 59 },
  { label: '60-69%', lo: 60, hi: 69 },
  { label: '70-79%', lo: 70, hi: 79 },
  { label: '80-89%', lo: 80, hi: 89 },
  { label: '90-100%', lo: 90, hi: 100 }
];

/**
 * Get the confidence bucket label for a numeric confidence value.
 * Returns null if confidence < 50.
 */
function getBucket(confidence) {
  const c = Number(confidence);
  if (!Number.isFinite(c) || c < 50) return null;
  for (const b of CONFIDENCE_BUCKETS) {
    if (c >= b.lo && c <= b.hi) return b.label;
  }
  return null;
}

/**
 * Create an empty calibration state.
 */
function emptyCalibration() {
  const buckets = {};
  for (const b of CONFIDENCE_BUCKETS) {
    buckets[b.label] = { predictionCount: 0, correct: 0, accuracy: null, averageReturn: null, sumReturn: 0 };
  }
  return {
    version: 1,
    updatedAt: null,
    totalPredictions: 0,
    buckets,
    calibrationError: null,
    agentCalibrations: {} // agentName -> calibration state
  };
}

/**
 * Record one prediction outcome into calibration state.
 * @param {object} state - calibration state (mutated in place)
 * @param {string} agentName - agent name (for per-agent calibration)
 * @param {number} confidence - model confidence (0-100)
 * @param {boolean} correct - was the prediction correct?
 * @param {number} realizedReturn - actual return percentage
 */
function record(state, agentName, confidence, correct, realizedReturn) {
  if (!state || !state.buckets) return;

  const bucket = getBucket(confidence);
  state.totalPredictions = (state.totalPredictions || 0) + 1;

  // Global calibration
  if (bucket && state.buckets[bucket]) {
    const b = state.buckets[bucket];
    b.predictionCount += 1;
    if (correct) b.correct += 1;
    b.sumReturn += Number.isFinite(realizedReturn) ? realizedReturn : 0;
    b.averageReturn = b.predictionCount > 0
      ? Math.round((b.sumReturn / b.predictionCount) * 1000) / 1000
      : null;
    b.accuracy = b.predictionCount > 0
      ? Math.round((b.correct / b.predictionCount) * 10000) / 100
      : null;
  }

  // Per-agent calibration
  if (agentName) {
    if (!state.agentCalibrations) state.agentCalibrations = {};
    if (!state.agentCalibrations[agentName]) {
      state.agentCalibrations[agentName] = emptyCalibration();
      state.agentCalibrations[agentName].agentCalibrations = {}; // prevent recursion
    }
    record(state.agentCalibrations[agentName], null, confidence, correct, realizedReturn);
  }

  // Recompute calibration error
  state.calibrationError = computeCalibrationError(state);
  state.updatedAt = Date.now();
}

/**
 * Compute calibration error: average absolute difference between
 * confidence midpoint and actual accuracy across populated buckets.
 */
function computeCalibrationError(state) {
  if (!state || !state.buckets) return null;
  let totalDiff = 0;
  let count = 0;
  for (const b of CONFIDENCE_BUCKETS) {
    const bucket = state.buckets[b.label];
    if (bucket && bucket.predictionCount >= 3 && bucket.accuracy != null) {
      const midpoint = (b.lo + b.hi) / 2;
      totalDiff += Math.abs(midpoint - bucket.accuracy);
      count += 1;
    }
  }
  return count > 0 ? Math.round((totalDiff / count) * 100) / 100 : null;
}

/**
 * Compute per-agent calibration error.
 */
function agentCalibrationError(state, agentName) {
  if (!state || !state.agentCalibrations || !state.agentCalibrations[agentName]) return null;
  return computeCalibrationError(state.agentCalibrations[agentName]);
}

/**
 * Merge two calibration states (for combining across restarts).
 */
function merge(base, incoming) {
  if (!base || !incoming) return base || incoming || emptyCalibration();
  const result = emptyCalibration();
  result.totalPredictions = (base.totalPredictions || 0) + (incoming.totalPredictions || 0);

  for (const b of CONFIDENCE_BUCKETS) {
    const bb = (base.buckets || {})[b.label] || { predictionCount: 0, correct: 0, sumReturn: 0 };
    const bi = (incoming.buckets || {})[b.label] || { predictionCount: 0, correct: 0, sumReturn: 0 };
    const merged = {
      predictionCount: bb.predictionCount + bi.predictionCount,
      correct: bb.correct + bi.correct,
      sumReturn: (bb.sumReturn || 0) + (bi.sumReturn || 0),
      accuracy: null,
      averageReturn: null
    };
    if (merged.predictionCount > 0) {
      merged.accuracy = Math.round((merged.correct / merged.predictionCount) * 10000) / 100;
      merged.averageReturn = Math.round((merged.sumReturn / merged.predictionCount) * 1000) / 1000;
    }
    result.buckets[b.label] = merged;
  }

  result.calibrationError = computeCalibrationError(result);
  result.updatedAt = Math.max(base.updatedAt || 0, incoming.updatedAt || 0) || Date.now();
  return result;
}

module.exports = {
  emptyCalibration,
  getBucket,
  record,
  computeCalibrationError,
  agentCalibrationError,
  merge,
  CONFIDENCE_BUCKETS
};
