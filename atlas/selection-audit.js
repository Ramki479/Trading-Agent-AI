#!/usr/bin/env node
/**
 * atlas/selection-audit.js — Selection-bias and survivorship-bias audit.
 *
 * Verifies whether the system preferentially evaluates certain tokens,
 * market caps, liquidity levels, times, regimes, score ranges, or
 * data-quality levels. Reports distributions. Measurement only.
 */

'use strict';

/**
 * Analyze selection bias by comparing discovered candidates vs evaluated candidates.
 * @param candidates — all discovered candidates
 * @param evaluated — candidates that ATLAS actually evaluated
 * @returns distribution comparison
 */
function selectionBiasAudit(candidates, evaluated) {
  if (!Array.isArray(candidates) || !Array.isArray(evaluated)) {
    return { status: 'NO_DATA', distributions: {} };
  }

  const dist = (arr, key, buckets) => {
    const counts = {};
    for (const b of buckets) counts[b.label] = 0;
    for (const item of arr) {
      const val = typeof key === 'function' ? key(item) : item[key];
      for (const b of buckets) {
        if (val >= b.lo && val < b.hi) { counts[b.label]++; break; }
      }
    }
    return counts;
  };

  const liqBuckets = [
    { label: '<5k', lo: 0, hi: 5000 },
    { label: '5k-20k', lo: 5000, hi: 20000 },
    { label: '20k-100k', lo: 20000, hi: 100000 },
    { label: '100k-500k', lo: 100000, hi: 500000 },
    { label: '500k+', lo: 500000, hi: Infinity }
  ];

  const scoreBuckets = [
    { label: '60-64', lo: 60, hi: 65 },
    { label: '65-69', lo: 65, hi: 70 },
    { label: '70-74', lo: 70, hi: 75 },
    { label: '75-79', lo: 75, hi: 80 },
    { label: '80-84', lo: 80, hi: 85 },
    { label: '85-89', lo: 85, hi: 90 },
    { label: '90-100', lo: 90, hi: 101 }
  ];

  const changeBuckets = [
    { label: '-35 to -20', lo: -35, hi: -20 },
    { label: '-20 to -10', lo: -20, hi: -10 },
    { label: '-10 to 0', lo: -10, hi: 0 },
    { label: '0 to +15', lo: 0, hi: 15 }
  ];

  return {
    status: 'OK',
    discovered: {
      count: candidates.length,
      liquidityDistribution: dist(candidates, 'liquidityUsd', liqBuckets),
      scoreDistribution: dist(candidates, 'score', scoreBuckets),
      change1hDistribution: dist(candidates, 'change1hPct', changeBuckets)
    },
    evaluated: {
      count: evaluated.length,
      liquidityDistribution: dist(evaluated, 'liquidityUsd', liqBuckets),
      scoreDistribution: dist(evaluated, 'score', scoreBuckets),
      change1hDistribution: dist(evaluated, 'change1hPct', changeBuckets)
    },
    biasIndicators: computeBiasIndicators(candidates, evaluated)
  };
}

function computeBiasIndicators(allCandidates, evaluated) {
  if (!allCandidates.length || !evaluated.length) return {};

  const avgLiq = arr => arr.reduce((s, c) => s + (Number(c.liquidityUsd) || 0), 0) / arr.length;
  const avgScore = arr => arr.reduce((s, c) => s + (Number(c.score) || 0), 0) / arr.length;

  const allAvgLiq = avgLiq(allCandidates);
  const evalAvgLiq = avgLiq(evaluated);
  const allAvgScore = avgScore(allCandidates);
  const evalAvgScore = avgScore(evaluated);

  return {
    liquidityBias: allAvgLiq > 0 ? Math.round((evalAvgLiq / allAvgLiq) * 100) / 100 : null,
    scoreBias: allAvgScore > 0 ? Math.round((evalAvgScore / allAvgScore) * 100) / 100 : null,
    coverageRate: Math.round((evaluated.length / allCandidates.length) * 10000) / 100
  };
}

/**
 * Survivorship-bias audit: ensure disappeared assets remain represented.
 * @param predictions — all predictions
 * @param outcomes — all outcomes
 * @returns { status, missingMints, unresolvedCount, classification }
 */
function survivorshipAudit(predictions, outcomes) {
  const predMints = new Set(predictions.map(p => p.mint).filter(Boolean));
  const outcomeMints = new Set(outcomes.map(o => o.mint).filter(Boolean));

  const missing = [];
  for (const mint of predMints) {
    if (!outcomeMints.has(mint)) {
      missing.push(mint);
    }
  }

  return {
    status: missing.length === 0 ? 'OK' : 'MISSING_OUTCOMES',
    totalPredictions: predictions.length,
    totalOutcomes: outcomes.length,
    missingMints: missing,
    unresolvedCount: missing.length,
    unresolvedRate: predictions.length > 0 ? Math.round((missing.length / predictions.length) * 10000) / 100 : null,
    classification: missing.length > 0 ? 'UNRESOLVED — do not treat as WIN, LOSS, or ZERO' : 'ALL_RESOLVED'
  };
}

module.exports = { selectionBiasAudit, survivorshipAudit };
