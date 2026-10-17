#!/usr/bin/env node
/**
 * atlas/statistics.js — ATLAS vs Circuit statistical comparison engine.
 *
 * Implements:
 *   - Matched-sample analysis (same candidate, same timestamp)
 *   - Bootstrap confidence intervals (95%)
 *   - Effect size (Cohen's d)
 *   - Paired statistical test (paired t-test / Wilcoxon signed-rank)
 *   - Evidence maturity checkpoints (30, 100, 200 samples)
 *   - Daily snapshots
 *
 * All calculations are deterministic in tests (seeded RNG for bootstrap).
 * Never uses future data. Never modifies production trading logic.
 */

'use strict';

const clamp = (n, lo, hi) => {
  if (lo == null) lo = -Infinity;
  if (hi == null) hi = Infinity;
  return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));
};

/* ------------------------------------------------------------------ *
 * Evidence maturity states.
 * ------------------------------------------------------------------ */

const CHECKPOINTS = [
  { sampleSize: 30,  label: 'CHECKPOINT_30',          description: 'Early signal — tentative' },
  { sampleSize: 100, label: 'CHECKPOINT_100',          description: 'Developing evidence' },
  { sampleSize: 200, label: 'CHECKPOINT_200',          description: 'Stronger evidence' }
];

const INSUFFICIENT_SAMPLE = 'INSUFFICIENT_SAMPLE';
const FINAL_VALIDATION = 'FINAL_VALIDATION'; // only via explicit analysis operation

/**
 * Determine evidence maturity state from matched sample count.
 */
function evidenceState(n) {
  if (n < 30)  return INSUFFICIENT_SAMPLE;
  if (n < 100) return 'CHECKPOINT_30';
  if (n < 200) return 'CHECKPOINT_100';
  return 'CHECKPOINT_200';
}

/**
 * Get checkpoint status for dashboard display.
 */
function checkpointStatus(n) {
  return {
    checkpoint30: n >= 30 ? 'REACHED' : 'NOT_REACHED',
    checkpoint100: n >= 100 ? 'REACHED' : 'NOT_REACHED',
    checkpoint200: n >= 200 ? 'REACHED' : 'NOT_REACHED',
    finalValidation: n >= 200 ? 'AVAILABLE' : 'NOT_READY'
  };
}

/* ------------------------------------------------------------------ *
 * Matched-sample analysis.
 *
 * For each candidate that was evaluated by both Circuit and ATLAS,
 * compute the return difference: atlasReturn - circuitReturn.
 * ------------------------------------------------------------------ */

function matchedSampleAnalysis(samples) {
  if (!Array.isArray(samples) || !samples.length) {
    return {
      matchedSamples: 0,
      meanDifference: null,
      medianDifference: null,
      standardDeviation: null,
      differences: [],
      circuitReturns: [],
      atlasReturns: []
    };
  }

  const differences = [];
  const circuitReturns = [];
  const atlasReturns = [];

  for (const s of samples) {
    const circR = Number.isFinite(s.circuitReturn) ? s.circuitReturn : 0;
    const atlasR = Number.isFinite(s.atlasReturn) ? s.atlasReturn : 0;
    differences.push(atlasR - circR);
    circuitReturns.push(circR);
    atlasReturns.push(atlasR);
  }

  const n = differences.length;
  const mean = differences.reduce((a, b) => a + b, 0) / n;
  const median = computeMedian(differences);
  const variance = differences.reduce((s, d) => s + (d - mean) ** 2, 0) / (n > 1 ? n - 1 : n);
  const std = Math.sqrt(variance);

  return {
    matchedSamples: n,
    meanDifference: round(mean, 6),
    medianDifference: round(median, 6),
    standardDeviation: round(std, 6),
    differences: differences.map(d => round(d, 6)),
    circuitReturns: circuitReturns.map(r => round(r, 6)),
    atlasReturns: atlasReturns.map(r => round(r, 6))
  };
}

/* ------------------------------------------------------------------ *
 * Bootstrap confidence intervals.
 *
 * Resample with replacement, compute mean of each resample.
 * Default: 10000 iterations, 95% CI.
 *
 * In tests, pass a seeded RNG for determinism.
 * ------------------------------------------------------------------ */

function bootstrapCI(data, opts = {}) {
  const iterations = opts.iterations || 10000;
  const ciLevel = opts.ciLevel || 0.95;
  const rng = opts.rng || Math.random;

  if (!Array.isArray(data) || data.length < 2) {
    return { mean: null, ciLower: null, ciUpper: null, iterations, ciLevel, insufficient: true };
  }

  const n = data.length;
  const bootMeans = [];

  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) {
      const idx = Math.floor(rng() * n);
      sum += data[idx];
    }
    bootMeans.push(sum / n);
  }

  bootMeans.sort((a, b) => a - b);

  const alpha = (1 - ciLevel) / 2;
  const loIdx = Math.floor(alpha * iterations);
  const hiIdx = Math.floor((1 - alpha) * iterations) - 1;

  const mean = data.reduce((a, b) => a + b, 0) / n;

  return {
    mean: round(mean, 6),
    ciLower: round(bootMeans[loIdx], 6),
    ciUpper: round(bootMeans[Math.min(hiIdx, iterations - 1)], 6),
    iterations,
    ciLevel,
    insufficient: false
  };
}

/**
 * Paired bootstrap CI for the mean difference.
 */
function pairedBootstrapCI(circuitReturns, atlasReturns, opts = {}) {
  if (!Array.isArray(circuitReturns) || !Array.isArray(atlasReturns) ||
      circuitReturns.length !== atlasReturns.length || circuitReturns.length < 2) {
    return { meanDifference: null, ciLower: null, ciUpper: null, insufficient: true };
  }
  const diffs = circuitReturns.map((c, i) => atlasReturns[i] - c);
  return bootstrapCI(diffs, opts);
}

/* ------------------------------------------------------------------ *
 * Effect size — Cohen's d for paired samples.
 *
 * d = mean(diff) / std(diff)
 *
 * Interpretation:
 *   |d| < 0.2  → negligible
 *   |d| < 0.5  → small
 *   |d| < 0.8  → medium
 *   |d| >= 0.8 → large
 * ------------------------------------------------------------------ */

function effectSize(matchedSamples) {
  if (!matchedSamples || matchedSamples.matchedSamples < 2) {
    return { d: null, interpretation: 'INSUFFICIENT_DATA', magnitude: 0 };
  }
  const mean = matchedSamples.meanDifference;
  const std = matchedSamples.standardDeviation;
  if (!Number.isFinite(mean) || !Number.isFinite(std) || std === 0) {
    return { d: 0, interpretation: 'NO_VARIATION', magnitude: 0 };
  }
  const d = mean / std;
  const absD = Math.abs(d);
  let interpretation;
  if (absD < 0.2) interpretation = 'NEGLIGIBLE';
  else if (absD < 0.5) interpretation = 'SMALL';
  else if (absD < 0.8) interpretation = 'MEDIUM';
  else interpretation = 'LARGE';

  return { d: round(d, 6), interpretation, magnitude: absD };
}

/* ------------------------------------------------------------------ *
 * Paired statistical test.
 *
 * Uses a simple paired t-test (parametric) when assumptions are met:
 *   - n >= 30 (Central Limit Theorem)
 *   - no extreme outliers (> 3σ from mean)
 *
 * Falls back to Wilcoxon signed-rank (non-parametric) when assumptions
 * fail or n < 30.
 *
 * Reports: testName, sampleSize, statistic, pValue (two-tailed),
 *          confidenceInterval, conclusion.
 * ------------------------------------------------------------------ */

function pairedTest(circuitReturns, atlasReturns) {
  if (!Array.isArray(circuitReturns) || !Array.isArray(atlasReturns) ||
      circuitReturns.length !== atlasReturns.length || circuitReturns.length < 5) {
    return {
      testName: 'none',
      sampleSize: circuitReturns ? circuitReturns.length : 0,
      statistic: null,
      pValue: null,
      confidenceInterval: [null, null],
      conclusion: 'INSUFFICIENT_EVIDENCE',
      note: 'Need at least 5 matched pairs'
    };
  }

  const diffs = circuitReturns.map((c, i) => atlasReturns[i] - c);
  const n = diffs.length;
  const mean = diffs.reduce((a, b) => a + b, 0) / n;
  const variance = diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / (n - 1);
  const std = Math.sqrt(variance);
  const se = std / Math.sqrt(n);

  // Check for extreme outliers (> 3σ)
  const outliers = diffs.filter(d => Math.abs(d - mean) > 3 * std);
  const useParametric = n >= 30 && outliers.length === 0;

  if (useParametric) {
    // Paired t-test
    const t = se > 0 ? mean / se : 0;
    // Approximate two-tailed p-value using t-distribution (Welch approximation)
    const pValue = approxTwoTailP(Math.abs(t), n - 1);
    const ciHalf = 1.96 * se; // approximate 95% CI

    return {
      testName: 'paired_t_test',
      sampleSize: n,
      statistic: round(t, 6),
      pValue: round(pValue, 6),
      confidenceInterval: [round(mean - ciHalf, 6), round(mean + ciHalf, 6)],
      conclusion: pValue < 0.05 ? 'SIGNIFICANT_AT_0.05' : 'NOT_SIGNIFICANT',
      note: outliers.length > 0 ? 'outliers detected' : 'parametric assumptions met'
    };
  }

  // Wilcoxon signed-rank (non-parametric)
  return wilcoxonSignedRank(diffs);
}

/* ------------------------------------------------------------------ *
 * Wilcoxon signed-rank test (non-parametric paired test).
 * ------------------------------------------------------------------ */

function wilcoxonSignedRank(diffs) {
  // Filter out zeros
  const nonzero = diffs.filter(d => d !== 0);
  const n = nonzero.length;
  if (n < 5) {
    return {
      testName: 'wilcoxon_signed_rank',
      sampleSize: n,
      statistic: null,
      pValue: null,
      confidenceInterval: [null, null],
      conclusion: 'INSUFFICIENT_EVIDENCE',
      note: 'Too few non-zero differences'
    };
  }

  // Rank absolute values
  const ranked = nonzero
    .map((d, i) => ({ val: d, abs: Math.abs(d), idx: i }))
    .sort((a, b) => a.abs - b.abs);

  // Assign ranks (handle ties with average rank)
  let i = 0;
  while (i < ranked.length) {
    let j = i;
    while (j < ranked.length && ranked[j].abs === ranked[i].abs) j++;
    const avgRank = (i + j + 1) / 2; // ranks are 1-indexed
    for (let k = i; k < j; k++) ranked[k].rank = avgRank;
    i = j;
  }

  // W+ = sum of ranks for positive diffs
  const wPlus = ranked.filter(r => r.val > 0).reduce((s, r) => s + r.rank, 0);
  const wMinus = ranked.filter(r => r.val < 0).reduce((s, r) => s + r.rank, 0);
  const wStat = Math.min(wPlus, wMinus);

  // Normal approximation for p-value (valid for n >= 10)
  const meanW = n * (n + 1) / 4;
  const stdW = Math.sqrt(n * (n + 1) * (2 * n + 1) / 24);
  const z = stdW > 0 ? (wStat - meanW) / stdW : 0;
  const pValue = approxTwoTailP(Math.abs(z), Infinity);

  // Hodges-Lehmann estimator for CI
  const allPairwiseMedians = [];
  for (let a = 0; a < diffs.length; a++) {
    for (let b = a; b < diffs.length; b++) {
      allPairwiseMedians.push((diffs[a] + diffs[b]) / 2);
    }
  }
  allPairwiseMedians.sort((a, b) => a - b);
  const ciIdx = Math.floor(0.025 * allPairwiseMedians.length);
  const ciHiIdx = Math.floor(0.975 * allPairwiseMedians.length) - 1;

  return {
    testName: 'wilcoxon_signed_rank',
    sampleSize: n,
    statistic: round(wStat, 6),
    pValue: round(pValue, 6),
    confidenceInterval: [
      round(allPairwiseMedians[Math.max(0, ciIdx)], 6),
      round(allPairwiseMedians[Math.min(ciHiIdx, allPairwiseMedians.length - 1)], 6)
    ],
    conclusion: pValue < 0.05 ? 'SIGNIFICANT_AT_0.05' : 'NOT_SIGNIFICANT',
    note: 'non-parametric — distribution-free'
  };
}

/* ------------------------------------------------------------------ *
 * Checkpoint system — persistent 30/100/200 checkpoints.
 * ------------------------------------------------------------------ */

function createCheckpoints(db) {
  function compute(matchedSamples, circuitReturns, atlasReturns, opts = {}) {
    const n = matchedSamples ? matchedSamples.matchedSamples : 0;
    const state = evidenceState(n);
    const ef = effectSize(matchedSamples);
    const test = pairedTest(circuitReturns, atlasReturns);
    const circuitCI = bootstrapCI(circuitReturns, opts);
    const atlasCI = bootstrapCI(atlasReturns, opts);
    const pairedCI = pairedBootstrapCI(circuitReturns, atlasReturns, opts);

    const checkpoint = {
      timestamp: Date.now(),
      iso: new Date().toISOString(),
      sampleSize: n,
      evidenceState: state,
      matched: {
        meanDifference: matchedSamples ? matchedSamples.meanDifference : null,
        medianDifference: matchedSamples ? matchedSamples.medianDifference : null,
        standardDeviation: matchedSamples ? matchedSamples.standardDeviation : null
      },
      effectSize: ef,
      statisticalTest: test,
      circuitBootstrap: circuitCI,
      atlasBootstrap: atlasCI,
      pairedBootstrap: pairedCI,
      limitations: computeLimitations(n, state, test, circuitCI, atlasCI),
      isCheckpoint: CHECKPOINTS.some(cp => n >= cp.sampleSize && n < cp.sampleSize + 10)
    };

    return checkpoint;
  }

  function computeLimitations(n, state, test, circuitCI, atlasCI) {
    const limitations = [];
    if (state === INSUFFICIENT_SAMPLE) limitations.push('INSUFFICIENT_SAMPLE: fewer than 30 matched pairs');
    if (state === 'EARLY_SIGNAL') limitations.push('EARLY_SIGNAL: conclusions are tentative — need 100+ for developing evidence');
    if (state === 'DEVELOPING_EVIDENCE') limitations.push('DEVELOPING_EVIDENCE: need 200+ for stronger evidence');
    if (test && test.conclusion === 'NOT_SIGNIFICANT') limitations.push('NO_CLEAR_RETURN_ADVANTAGE: ATLAS vs Circuit difference not statistically significant');
    if (circuitCI && circuitCI.ciLower != null && circuitCI.ciLower < 0 && circuitCI.ciUpper > 0) {
      limitations.push('CIRCUIT_CI_CROSSES_ZERO: Circuit mean return confidence interval includes zero');
    }
    if (atlasCI && atlasCI.ciLower != null && atlasCI.ciLower < 0 && atlasCI.ciUpper > 0) {
      limitations.push('ATLAS_CI_CROSSES_ZERO: ATLAS mean return confidence interval includes zero');
    }
    if (n < 100) limitations.push('Small sample — do not draw firm conclusions');
    return limitations;
  }

  function persistCheckpoint(checkpoint) {
    try {
      const existing = db.readJson ? db.readJson('atlas-checkpoints.json') : null;
      const checkpoints = (existing && existing.checkpoints) ? existing.checkpoints : [];
      checkpoints.push(checkpoint);
      // Keep last 100 checkpoints
      if (checkpoints.length > 100) {
        checkpoints.splice(0, checkpoints.length - 100);
      }
      if (db.writeJson) db.writeJson('atlas-checkpoints.json', { checkpoints, updatedAt: Date.now() });
    } catch (_) { /* best effort */ }
  }

  function loadCheckpoints() {
    try {
      const existing = db.readJson ? db.readJson('atlas-checkpoints.json') : null;
      return (existing && existing.checkpoints) ? existing.checkpoints : [];
    } catch (_) { return []; }
  }

  return { compute, persistCheckpoint, loadCheckpoints };
}

/* ------------------------------------------------------------------ *
 * Daily snapshot — persistent daily statistics.
 * ------------------------------------------------------------------ */

function createDailySnapshots(db) {
  function record(date, stats) {
    if (!date || !stats) return;
    const d = typeof date === 'string' ? date : new Date(date).toISOString().slice(0, 10);
    try {
      const existing = db.readJson ? db.readJson('atlas-daily.json') : null;
      const days = (existing && existing.days) ? existing.days : {};
      // Preserve existing historical data — never overwrite a previous day's snapshot
      if (days[d]) return;
      days[d] = Object.assign({ date: d, updatedAt: Date.now() }, stats);
      if (db.writeJson) db.writeJson('atlas-daily.json', { days, updatedAt: Date.now() });
    } catch (_) { /* best effort */ }
  }

  function getDay(date) {
    const d = typeof date === 'string' ? date : new Date(date).toISOString().slice(0, 10);
    try {
      const existing = db.readJson ? db.readJson('atlas-daily.json') : null;
      return (existing && existing.days && existing.days[d]) || null;
    } catch (_) { return null; }
  }

  function allDays() {
    try {
      const existing = db.readJson ? db.readJson('atlas-daily.json') : null;
      return (existing && existing.days) ? existing.days : {};
    } catch (_) { return {}; }
  }

  /**
   * Phase 12 (audit P2-01): buildDailyStats previously index-paired
   * outcomes[i] with circuitReturns[i]/atlasReturns[i] even though the return
   * arrays came from a DIFFERENT population (A/B comparisons). That produced
   * fabricated accuracy/return statistics.
   *
   * Correct semantics — two independent populations, never index-paired:
   *   Population 1: prediction OUTCOMES (flat pnlPct, direction). Used for
   *     resolution counts and ATLAS directional accuracy.
   *   Population 2: A/B comparisons — each row { v1Return, atlasReturn,
   *     predictionId? } is an intrinsically matched pair (same trade viewed
   *     by V1 vs V1+ATLAS). Paired/return/win-rate stats come ONLY from here.
   *   When a comparison row carries predictionId it may additionally be
   *   joined to its outcome by ID (used to count matched-by-id pairs).
   *
   * @param outcomes     resolved prediction outcomes (o.pnlPct flat)
   * @param predictions  all predictions
   * @param comparisons  A/B comparison rows (was: parallel return arrays)
   */
  function buildDailyStats(outcomes, predictions, comparisons) {
    const preds = Array.isArray(predictions) ? predictions : [];
    const outs = (Array.isArray(outcomes) ? outcomes : [])
      .filter(o => o && o.predictionId && Number.isFinite(o.pnlPct));

    // Population 1: outcome-level directional accuracy, computed from the
    // outcome's own direction + realized P&L.
    let atlasOutcomeWins = 0;
    for (const o of outs) {
      const won = o.pnlPct > 0;
      if ((o.direction === 'bullish' && won) || (o.direction === 'bearish' && !won)) atlasOutcomeWins += 1;
    }

    // Population 2: A/B paper comparisons (paired within each row).
    const comps = (Array.isArray(comparisons) ? comparisons : [])
      .filter(c => c && Number.isFinite(c.v1Return) && Number.isFinite(c.atlasReturn));
    const nC = comps.length;
    let circuitSum = 0, atlasSum = 0, circuitWins = 0, atlasWinsC = 0;
    let joinedById = 0;
    if (nC > 0) {
      const outcomeById = new Map(outs.map(o => [o.predictionId, o]));
      for (const c of comps) {
        circuitSum += c.v1Return;
        atlasSum += c.atlasReturn;
        if (c.v1Return > 0) circuitWins += 1;
        if (c.atlasReturn > 0) atlasWinsC += 1;
        if (c.predictionId && outcomeById.has(c.predictionId)) joinedById += 1;
      }
    }

    return {
      predictions: preds.length,
      resolved: outs.length,
      unresolved: Math.max(0, preds.length - outs.length),
      atlasAccuracy: outs.length > 0 ? round((atlasOutcomeWins / outs.length) * 100, 2) : null,
      circuitAccuracy: nC > 0 ? round((circuitWins / nC) * 100, 2) : null,
      abAtlasAccuracy: nC > 0 ? round((atlasWinsC / nC) * 100, 2) : null,
      circuitMeanReturn: nC > 0 ? round(circuitSum / nC, 6) : null,
      atlasMeanReturn: nC > 0 ? round(atlasSum / nC, 6) : null,
      pairedMeanDifference: nC > 0 ? round((atlasSum - circuitSum) / nC, 6) : null,
      matchedById: joinedById,
      // Historical field: V1 win rate from the A/B population.
      winRate: nC > 0 ? round((circuitWins / nC) * 100, 2) : null,
      evidenceState: evidenceState(outs.length)
    };
  }

  return { record, getDay, allDays, buildDailyStats };
}

/* ------------------------------------------------------------------ *
 * Utilities.
 * ------------------------------------------------------------------ */

function round(n, decimals) {
  if (!Number.isFinite(n)) return 0;
  const f = Math.pow(10, decimals || 0);
  return Math.round(n * f) / f;
}

function computeMedian(arr) {
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/**
 * Approximate two-tailed p-value from t or z statistic.
 * Uses normal approximation for large df, t-approximation for small.
 */
function approxTwoTailP(absStat, df) {
  if (!Number.isFinite(absStat)) return 1;
  if (df === Infinity) {
    // Standard normal CDF approximation
    const x = absStat;
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429;
    const p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    const xAbs = Math.abs(x) / Math.sqrt(2);
    const t = 1.0 / (1.0 + p * xAbs);
    const erf = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-xAbs * xAbs);
    return round(1 - erf, 6);
  }
  // For t-distribution: use normal approx when df > 30
  if (df > 30) return approxTwoTailP(absStat, Infinity);
  // Very rough t-distribution approximation
  const x = absStat;
  const v = df;
  const p = 0.5 * Math.pow(1 + 0.3275911 * x / Math.sqrt(v + x * x), -(v + 1) / 2);
  return round(2 * Math.min(p, 1 - p), 6);
}

module.exports = {
  CHECKPOINTS,
  INSUFFICIENT_SAMPLE,
  FINAL_VALIDATION,
  evidenceState,
  checkpointStatus,
  matchedSampleAnalysis,
  bootstrapCI,
  pairedBootstrapCI,
  effectSize,
  pairedTest,
  wilcoxonSignedRank,
  createCheckpoints,
  createDailySnapshots,
  computeMedian,
  round,
  approxTwoTailP
};
