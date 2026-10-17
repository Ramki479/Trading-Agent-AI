#!/usr/bin/env node
/**
 * atlas/checkpoint30-analysis.js — Checkpoint 30 evidence analysis & statistical validation.
 *
 * Prepares and validates the complete statistical evidence-analysis pipeline
 * for when CHECKPOINT_30 reaches 30+ REAL matched observations.
 *
 * If the real dataset contains fewer than 30 matched observations,
 * this module reports CHECKPOINT_30_NOT_REACHED and stops analysis.
 *
 * Usage: node atlas/checkpoint30-analysis.js [--data-dir <path>]
 *
 * MUST NOT:
 *   - manufacture synthetic observations
 *   - execute trades
 *   - modify Circuit V1 strategy
 *   - modify paper ledger
 *   - promote ATLAS automatically
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const statsLib = require('./statistics.js');
const { computeDatasetHash } = require('./dataset-hash.js');
const { auditBatch } = require('./lookahead-audit.js');
const { calibrationAudit } = require('./checkpoint-review.js');
const { CONFIDENCE_BUCKETS } = require('./calibration.js');
const { selectionBiasAudit, survivorshipAudit } = require('./selection-audit.js');
const { constructMatchedSamples, isExcluded, deduplicatePredictions, computeGroupStats, computePairedStats } = require('./analyze-evidence.js');
const { AtlasDb } = require('./db.js');

const CODE_VERSION = 'ATLAS-0.2.0';
const ANALYSIS_VERSION = '1.0.0';
const PRACTICAL_THRESHOLD_PCT = 0.5; // minimum practical improvement threshold (%)

/* ------------------------------------------------------------------ *
 * Data loading.
 * ------------------------------------------------------------------ */

function loadData(dataDir) {
  const db = new AtlasDb(dataDir);
  return {
    db,
    predictions: db.predictions ? db.predictions() : [],
    outcomes: db.outcomes ? db.outcomes() : [],
    evidence: db.evidence ? db.evidence() : [],
    abPaperState: db.readJson ? db.readJson('atlas-ab-paper.json') : null,
    checkpoints: db.readJson ? db.readJson('atlas-checkpoints.json') : null,
    reputation: db.reputation ? db.reputation() : null,
    calibration: db.readJson ? db.readJson('atlas-calibration.json') : null
  };
}

function readJsonl(dir, file) {
  const f = path.join(dir, file);
  if (!fs.existsSync(f)) return [];
  try {
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch (_) { return null; }
    }).filter(Boolean);
  } catch (_) { return []; }
}

/* ------------------------------------------------------------------ *
 * Seeded RNG for deterministic bootstrap.
 * ------------------------------------------------------------------ */

function createSeededRng(seed) {
  let s = seed;
  return function() {
    s = (s * 1664525 + 1013904223) & 0xFFFFFFFF;
    return (s >>> 0) / 0xFFFFFFFF;
  };
}

function seedFromHash(datasetHash) {
  if (!datasetHash || datasetHash === 'PENDING' || datasetHash === 'EMPTY') return 42;
  // Extract numeric seed from hex hash
  const hex = datasetHash.slice(0, 8);
  return parseInt(hex, 16) || 42;
}

/* ------------------------------------------------------------------ *
 * Matched sample validation.
 * ------------------------------------------------------------------ */

function validateMatchedSamples(matched) {
  const valid = [];
  const excluded = [];

  for (const m of matched) {
    const reasons = [];

    // Missing prediction ID
    if (!m.predictionId) reasons.push('NO_PREDICTION_ID');

    // Duplicate prediction ID (checked later, but flag here too)
    // Missing mint
    if (!m.mint) reasons.push('NO_MINT');

    // Invalid timestamps
    if (!Number.isFinite(m.predictionTimestamp)) reasons.push('INVALID_PREDICTION_TS');

    // Look-ahead: resolution must be after prediction
    if (Number.isFinite(m.predictionTimestamp) && Number.isFinite(m.outcomeRealizedAt)) {
      if (m.outcomeRealizedAt <= m.predictionTimestamp) {
        reasons.push('LOOKAHEAD_VIOLATION');
      }
    }

    // Missing outcome
    if (m.outcomePnlPct == null || !Number.isFinite(m.outcomePnlPct)) {
      reasons.push('MISSING_OUTCOME');
    }

    // Suspicious data quality
    if (m.dataQuality === 'suspicious' || m.dataQuality === 'fail' || m.dataQuality === 'quarantined') {
      reasons.push('SUSPICIOUS_DATA');
    }

    // PAIR_CHANGED
    if (m.reasons && m.reasons.includes('PAIR_CHANGED')) {
      reasons.push('PAIR_CHANGED');
    }

    // Stale observation
    if (m.dataQuality === 'stale') {
      reasons.push('STALE_OBSERVATION');
    }

    if (reasons.length > 0) {
      excluded.push({ predictionId: m.predictionId, mint: m.mint, reasons });
    } else {
      valid.push(m);
    }
  }

  return { valid, excluded };
}

/* ------------------------------------------------------------------ *
 * Duplicate audit.
 * ------------------------------------------------------------------ */

function duplicateAudit(matched) {
  const predIds = matched.map(m => m.predictionId).filter(Boolean);
  const uniquePredIds = new Set(predIds);
  const dupPredIds = predIds.length - uniquePredIds.size;

  const fingerprints = matched.map(m => [m.mint, m.pairAddress || '', m.predictionTimestamp || 0, m.circuitReturn || 0].join('|'));
  const uniqueFingerprints = new Set(fingerprints);
  const dupFingerprints = fingerprints.length - uniqueFingerprints.size;

  return {
    duplicatePredictionIds: dupPredIds,
    duplicateFingerprints: dupFingerprints,
    totalObservations: matched.length
  };
}

/* ------------------------------------------------------------------ *
 * Look-ahead audit.
 * ------------------------------------------------------------------ */

function lookAheadAudit(matched) {
  const pairs = matched.map(m => ({
    prediction: { ts: m.predictionTimestamp, predictionId: m.predictionId },
    outcome: { realizedAt: m.outcomeRealizedAt || 0 }
  }));
  const result = auditBatch(pairs);
  return {
    violations: result.violations,
    validSamples: matched.length - result.violations,
    affectedPredictionIds: result.details.filter(d => d.violation === 'FUTURE_DATA').map(d => d.predictionId)
  };
}

/* ------------------------------------------------------------------ *
 * Primary statistics (30m paired differences).
 * ------------------------------------------------------------------ */

function primaryStatistics(matched) {
  if (!matched || matched.length === 0) {
    return {
      n: 0, mean: null, median: null, standardDeviation: null,
      min: null, max: null,
      meanV1Return: null, meanATLASReturn: null,
      medianV1Return: null, medianATLASReturn: null,
      atlasWinCount: 0, v1WinCount: 0, tieCount: 0,
      winRateDifference: null
    };
  }

  const diffs = matched.map(m => m.atlasReturn - m.circuitReturn);
  const v1Returns = matched.map(m => m.circuitReturn);
  const atlasReturns = matched.map(m => m.atlasReturn);

  const n = diffs.length;
  const mean = diffs.reduce((a, b) => a + b, 0) / n;
  const sorted = diffs.slice().sort((a, b) => a - b);
  const median = n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)];
  const variance = diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / (n > 1 ? n - 1 : n);
  const std = Math.sqrt(variance);

  const meanV1 = v1Returns.reduce((a, b) => a + b, 0) / n;
  const meanATLAS = atlasReturns.reduce((a, b) => a + b, 0) / n;
  const sortedV1 = v1Returns.slice().sort((a, b) => a - b);
  const sortedATLAS = atlasReturns.slice().sort((a, b) => a - b);
  const medianV1 = n % 2 === 0 ? (sortedV1[n / 2 - 1] + sortedV1[n / 2]) / 2 : sortedV1[Math.floor(n / 2)];
  const medianATLAS = n % 2 === 0 ? (sortedATLAS[n / 2 - 1] + sortedATLAS[n / 2]) / 2 : sortedATLAS[Math.floor(n / 2)];

  const atlasWins = atlasReturns.filter(r => r > 0).length;
  const v1Wins = v1Returns.filter(r => r > 0).length;
  const ties = diffs.filter(d => d === 0).length;

  return {
    n,
    mean: round(mean, 6),
    median: round(median, 6),
    standardDeviation: round(std, 6),
    min: round(sorted[0], 6),
    max: round(sorted[n - 1], 6),
    meanV1Return: round(meanV1, 6),
    meanATLASReturn: round(meanATLAS, 6),
    medianV1Return: round(medianV1, 6),
    medianATLASReturn: round(medianATLAS, 6),
    atlasWinCount: atlasWins,
    v1WinCount: v1Wins,
    tieCount: ties,
    winRateDifference: round(((atlasWins / n) - (v1Wins / n)) * 100, 2)
  };
}

/* ------------------------------------------------------------------ *
 * Bootstrap analysis.
 * ------------------------------------------------------------------ */

function bootstrapAnalysis(matched, datasetHash, iterations) {
  iterations = iterations || 10000;
  if (!matched || matched.length < 2) {
    return { insufficient: true, mean: null, ciLower: null, ciUpper: null, iterations };
  }

  const diffs = matched.map(m => m.atlasReturn - m.circuitReturn);
  const seed = seedFromHash(datasetHash);
  const rng = createSeededRng(seed);

  const ci = statsLib.bootstrapCI(diffs, { iterations, rng });

  return {
    insufficient: ci.insufficient,
    mean: ci.mean,
    ciLower: ci.ciLower,
    ciUpper: ci.ciUpper,
    iterations,
    seed,
    ciLevel: 0.95
  };
}

/* ------------------------------------------------------------------ *
 * Effect size analysis.
 * ------------------------------------------------------------------ */

function effectSizeAnalysis(matched) {
  if (!matched || matched.length < 2) {
    return { d: null, interpretation: 'INSUFFICIENT_DATA', magnitude: 0 };
  }
  const analysis = statsLib.matchedSampleAnalysis(
    matched.map(m => ({ circuitReturn: m.circuitReturn, atlasReturn: m.atlasReturn }))
  );
  return statsLib.effectSize(analysis);
}

/* ------------------------------------------------------------------ *
 * Statistical test analysis.
 * ------------------------------------------------------------------ */

function statisticalTestAnalysis(matched) {
  if (!matched || matched.length < 5) {
    return { testName: 'none', sampleSize: matched ? matched.length : 0, statistic: null, pValue: null, conclusion: 'INSUFFICIENT_EVIDENCE' };
  }
  const v1Returns = matched.map(m => m.circuitReturn);
  const atlasReturns = matched.map(m => m.atlasReturn);
  return statsLib.pairedTest(v1Returns, atlasReturns);
}

/* ------------------------------------------------------------------ *
 * Economic significance assessment.
 * ------------------------------------------------------------------ */

function economicSignificance(matched) {
  if (!matched || matched.length === 0) {
    return {
      meanImprovement: null,
      medianImprovement: null,
      atlasBetterCount: 0,
      atlasWorseCount: 0,
      tiedCount: 0,
      atlasBetterPct: null,
      atlasWorsePct: null,
      tiedPct: null,
      exceedsThreshold: false,
      thresholdPct: PRACTICAL_THRESHOLD_PCT
    };
  }

  const diffs = matched.map(m => m.atlasReturn - m.circuitReturn);
  const n = diffs.length;
  const mean = diffs.reduce((a, b) => a + b, 0) / n;
  const sorted = diffs.slice().sort((a, b) => a - b);
  const median = n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)];

  const atlasBetter = diffs.filter(d => d > 0).length;
  const atlasWorse = diffs.filter(d => d < 0).length;
  const tied = diffs.filter(d => d === 0).length;

  return {
    meanImprovement: round(mean, 6),
    medianImprovement: round(median, 6),
    atlasBetterCount: atlasBetter,
    atlasWorseCount: atlasWorse,
    tiedCount: tied,
    atlasBetterPct: round((atlasBetter / n) * 100, 2),
    atlasWorsePct: round((atlasWorse / n) * 100, 2),
    tiedPct: round((tied / n) * 100, 2),
    exceedsThreshold: Math.abs(mean) >= PRACTICAL_THRESHOLD_PCT,
    thresholdPct: PRACTICAL_THRESHOLD_PCT
  };
}

/* ------------------------------------------------------------------ *
 * Confidence interval interpretation.
 * ------------------------------------------------------------------ */

function interpretCI(bootstrapResult) {
  if (!bootstrapResult || bootstrapResult.insufficient) {
    return { classification: 'INSUFFICIENT_DATA', note: 'Cannot interpret — insufficient bootstrap data' };
  }
  const { ciLower, ciUpper } = bootstrapResult;
  if (ciLower == null || ciUpper == null) {
    return { classification: 'INSUFFICIENT_DATA', note: 'CI bounds are null' };
  }
  if (ciLower > 0 && ciUpper > 0) {
    return { classification: 'POSITIVE_DIRECTIONAL', note: 'Entire 95% CI is positive — positive directional evidence' };
  }
  if (ciLower < 0 && ciUpper < 0) {
    return { classification: 'NEGATIVE_DIRECTIONAL', note: 'Entire 95% CI is negative — negative directional evidence' };
  }
  return { classification: 'UNCERTAIN', note: '95% CI crosses zero — uncertain / inconclusive' };
}

/* ------------------------------------------------------------------ *
 * Regime analysis.
 * ------------------------------------------------------------------ */

function regimeAnalysis(matched) {
  const regimes = {};
  for (const m of matched) {
    const regime = m.marketRegime || 'unknown';
    if (!regimes[regime]) {
      regimes[regime] = { sampleSize: 0, circuitReturns: [], atlasReturns: [], differences: [] };
    }
    regimes[regime].sampleSize++;
    regimes[regime].circuitReturns.push(m.circuitReturn);
    regimes[regime].atlasReturns.push(m.atlasReturn);
    regimes[regime].differences.push(m.atlasReturn - m.circuitReturn);
  }

  const result = {};
  for (const [regime, data] of Object.entries(regimes)) {
    if (data.sampleSize < 3) {
      result[regime] = {
        sampleSize: data.sampleSize,
        status: 'INSUFFICIENT_REGIME_SAMPLE',
        meanDifference: null,
        medianDifference: null,
        winRate: null,
        bootstrapCI: null
      };
      continue;
    }

    const n = data.sampleSize;
    const mean = data.differences.reduce((a, b) => a + b, 0) / n;
    const sorted = data.differences.slice().sort((a, b) => a - b);
    const median = n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)];
    const wins = data.differences.filter(d => d > 0).length;

    let bootstrapCI = null;
    if (n >= 10) {
      bootstrapCI = statsLib.bootstrapCI(data.differences, { iterations: 1000, rng: Math.random });
    }

    result[regime] = {
      sampleSize: n,
      status: 'OK',
      meanDifference: round(mean, 6),
      medianDifference: round(median, 6),
      winRate: round((wins / n) * 100, 2),
      bootstrapCI: bootstrapCI && !bootstrapCI.insufficient ? { lower: bootstrapCI.ciLower, upper: bootstrapCI.ciUpper } : null
    };
  }

  return result;
}

/* ------------------------------------------------------------------ *
 * Agent attribution analysis.
 * ------------------------------------------------------------------ */

function agentAttributionAnalysis(matched) {
  const agents = {};
  for (const m of matched) {
    const agent = m.agent || 'unknown';
    if (!agents[agent]) {
      agents[agent] = {
        predictionCount: 0, directionalCorrect: 0, directionalIncorrect: 0,
        returns: [], confidences: [], winRate: null, meanReturn: null, medianReturn: null
      };
    }
    const a = agents[agent];
    a.predictionCount++;
    if (m.direction === 'bullish' && m.outcomePnlPct > 0) a.directionalCorrect++;
    else if (m.direction === 'bearish' && m.outcomePnlPct < 0) a.directionalCorrect++;
    else a.directionalIncorrect++;
    a.returns.push(m.outcomePnlPct || 0);
    a.confidences.push(m.confidence || 0);
  }

  // Compute summary stats
  for (const [name, a] of Object.entries(agents)) {
    if (a.predictionCount > 0) {
      a.winRate = round((a.directionalCorrect / a.predictionCount) * 100, 2);
      a.meanReturn = round(a.returns.reduce((x, y) => x + y, 0) / a.predictionCount, 4);
      const sorted = a.returns.slice().sort((x, y) => x - y);
      const n = sorted.length;
      a.medianReturn = n % 2 === 0 ? round((sorted[n / 2 - 1] + sorted[n / 2]) / 2, 4) : round(sorted[Math.floor(n / 2)], 4);
      a.meanConfidence = round(a.confidences.reduce((x, y) => x + y, 0) / a.predictionCount, 1);
    }
    // Remove raw arrays from output
    delete a.returns;
    delete a.confidences;
  }

  return agents;
}

/* ------------------------------------------------------------------ *
 * Calibration analysis.
 * ------------------------------------------------------------------ */

function calibrationAnalysis(matched) {
  return calibrationAudit(matched);
}

/* ------------------------------------------------------------------ *
 * Disagreement analysis.
 * ------------------------------------------------------------------ */

function disagreementAnalysis(matched) {
  if (!matched || matched.length === 0) {
    return { totalSamples: 0, disagreements: 0, disagreementRate: null, avgDifferenceMagnitude: null };
  }

  const diffs = matched.map(m => m.atlasReturn - m.circuitReturn);
  const disagreements = diffs.filter(d => d !== 0).length;
  const avgMag = diffs.reduce((s, d) => s + Math.abs(d), 0) / diffs.length;

  return {
    totalSamples: matched.length,
    disagreements,
    disagreementRate: round((disagreements / matched.length) * 100, 2),
    avgDifferenceMagnitude: round(avgMag, 6)
  };
}

/* ------------------------------------------------------------------ *
 * Data quality analysis.
 * ------------------------------------------------------------------ */

function dataQualityAnalysis(matched) {
  const tiers = { ok: 0, suspicious: 0, stale: 0, unknown: 0 };
  for (const m of matched) {
    const dq = m.dataQuality || 'unknown';
    if (dq === 'ok') tiers.ok++;
    else if (dq === 'suspicious') tiers.suspicious++;
    else if (dq === 'stale') tiers.stale++;
    else tiers.unknown++;
  }
  return {
    total: matched.length,
    ok: tiers.ok,
    suspicious: tiers.suspicious,
    stale: tiers.stale,
    unknown: tiers.unknown,
    qualityRate: matched.length > 0 ? round((tiers.ok / matched.length) * 100, 2) : null
  };
}

/* ------------------------------------------------------------------ *
 * Temporal stability analysis.
 * ------------------------------------------------------------------ */

function temporalStability(matched) {
  if (!matched || matched.length < 4) {
    return { status: 'INSUFFICIENT_DATA', firstHalf: null, secondHalf: null };
  }

  const midpoint = Math.floor(matched.length / 2);
  const firstHalf = matched.slice(0, midpoint);
  const secondHalf = matched.slice(midpoint);

  function halfStats(half) {
    if (half.length === 0) return null;
    const diffs = half.map(m => m.atlasReturn - m.circuitReturn);
    const n = diffs.length;
    const mean = diffs.reduce((a, b) => a + b, 0) / n;
    const sorted = diffs.slice().sort((a, b) => a - b);
    const median = n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)];
    const wins = diffs.filter(d => d > 0).length;
    return {
      sampleSize: n,
      meanDifference: round(mean, 6),
      medianDifference: round(median, 6),
      winRate: round((wins / n) * 100, 2)
    };
  }

  const first = halfStats(firstHalf);
  const second = halfStats(secondHalf);

  let trend = 'STABLE';
  if (first && second) {
    if (second.meanDifference > first.meanDifference * 1.5) trend = 'IMPROVING';
    else if (second.meanDifference < first.meanDifference * 0.5) trend = 'DECLINING';
    else if (first.meanDifference > 0 && second.meanDifference < 0) trend = 'REVERSING';
  }

  return { status: 'OK', firstHalf: first, secondHalf: second, trend };
}

/* ------------------------------------------------------------------ *
 * Dataset hashing and immutability.
 * ------------------------------------------------------------------ */

function createDatasetSnapshot(matched) {
  const hash = computeDatasetHash(matched);
  return {
    datasetHash: hash,
    analysisVersion: ANALYSIS_VERSION,
    codeVersion: CODE_VERSION,
    sampleCount: matched.length,
    createdAt: Date.now(),
    predictionIds: matched.map(m => m.predictionId).filter(Boolean)
  };
}

/* ------------------------------------------------------------------ *
 * Full analysis pipeline.
 * ------------------------------------------------------------------ */

function analyze(dataDir, opts) {
  opts = opts || {};
  const bootstrapIterations = opts.bootstrapIterations || 10000;

  // Step 1: Load data
  const data = loadData(dataDir);

  // Step 2: Construct matched samples
  const { matched: rawMatched, excluded: rawExcluded, total } = constructMatchedSamples(data);

  // Step 3: Validate matched samples
  const { valid, excluded: validationExcluded } = validateMatchedSamples(rawMatched);

  // Step 4: Check n < 30
  const n = valid.length;
  if (n < 30) {
    return {
      status: 'CHECKPOINT_30_NOT_REACHED',
      sampleCount: n,
      required: 30,
      reason: `Matched samples (${n}) < 30. Cannot evaluate evidence.`,
      dataDir,
      codeVersion: CODE_VERSION,
      analysisVersion: ANALYSIS_VERSION,
      totalObservations: total,
      validObservations: n,
      excludedObservations: rawExcluded.length + validationExcluded.length,
      matched: null,
      primary: null,
      bootstrap: null,
      effectSize: null,
      statisticalTest: null,
      economic: null,
      ciInterpretation: null,
      regimes: null,
      agents: null,
      calibration: null,
      disagreement: null,
      dataQuality: null,
      temporal: null,
      duplicates: null,
      lookahead: null,
      dataset: null,
      promotion: { automaticallyPromoted: false, result: 'NOT_READY' }
    };
  }

  // Step 5: Duplicate audit
  const dups = duplicateAudit(valid);

  // Step 6: Look-ahead audit
  const lookahead = lookAheadAudit(valid);

  // Step 7: Dataset snapshot
  const dataset = createDatasetSnapshot(valid);

  // Step 8: Primary statistics
  const primary = primaryStatistics(valid);

  // Step 9: Bootstrap
  const bootstrap = bootstrapAnalysis(valid, dataset.datasetHash, bootstrapIterations);

  // Step 10: Effect size
  const effectSize = effectSizeAnalysis(valid);

  // Step 11: Statistical test
  const statisticalTest = statisticalTestAnalysis(valid);

  // Step 12: Economic significance
  const economic = economicSignificance(valid);

  // Step 13: CI interpretation
  const ciInterpretation = interpretCI(bootstrap);

  // Step 14: Regime analysis
  const regimes = regimeAnalysis(valid);

  // Step 15: Agent attribution
  const agents = agentAttributionAnalysis(valid);

  // Step 16: Calibration
  const cal = calibrationAnalysis(valid);

  // Step 17: Disagreement
  const disagreement = disagreementAnalysis(valid);

  // Step 18: Data quality
  const dq = dataQualityAnalysis(valid);

  // Step 19: Temporal stability
  const temporal = temporalStability(valid);

  // Step 20: Exclusion summary
  const exclusionReasons = {};
  for (const e of [...rawExcluded, ...validationExcluded]) {
    for (const r of (e.reasons || [])) {
      exclusionReasons[r] = (exclusionReasons[r] || 0) + 1;
    }
  }

  // Step 21: Promotion assessment (READ-ONLY, never auto-promotes)
  const promotion = {
    result: 'NOT_READY',
    note: 'Checkpoint 30 is preliminary. Continue collecting toward 100+.',
    automaticallyPromoted: false
  };

  return {
    status: 'ANALYSIS_COMPLETE',
    sampleCount: n,
    required: 30,
    dataDir,
    codeVersion: CODE_VERSION,
    analysisVersion: ANALYSIS_VERSION,

    totalObservations: total,
    validObservations: n,
    excludedObservations: rawExcluded.length + validationExcluded.length,
    validationExcluded: validationExcluded.length,
    exclusionReasons,

    matched: valid.slice(0, 500), // cap for export
    primary,
    bootstrap,
    effectSize,
    statisticalTest,
    economic,
    ciInterpretation,
    regimes,
    agents,
    calibration: cal,
    disagreement,
    dataQuality: dq,
    temporal,
    duplicates: dups,
    lookahead,
    dataset,
    promotion,

    timestamp: Date.now(),
    iso: new Date().toISOString()
  };
}

/* ------------------------------------------------------------------ *
 * Deterministic re-analysis (reproducibility check).
 * ------------------------------------------------------------------ */

function reproducibilityCheck(dataDir, firstResult) {
  const second = analyze(dataDir, { bootstrapIterations: firstResult.bootstrap ? firstResult.bootstrap.iterations : 10000 });

  return {
    sameSampleCount: firstResult.sampleCount === second.sampleCount,
    sameDatasetHash: firstResult.dataset && second.dataset ? firstResult.dataset.datasetHash === second.dataset.datasetHash : false,
    sameClassification: firstResult.status === second.status,
    sameEffectSize: firstResult.effectSize && second.effectSize ? firstResult.effectSize.d === second.effectSize.d : false,
    sameBootstrapMean: firstResult.bootstrap && second.bootstrap ? firstResult.bootstrap.mean === second.bootstrap.mean : false,
    sameDecisionId: firstResult.dataset && second.dataset ? firstResult.dataset.datasetHash === second.dataset.datasetHash : false,
    passed: firstResult.sampleCount === second.sampleCount &&
            (firstResult.dataset && second.dataset ? firstResult.dataset.datasetHash === second.dataset.datasetHash : true) &&
            firstResult.status === second.status
  };
}

/* ------------------------------------------------------------------ *
 * Utilities.
 * ------------------------------------------------------------------ */

function round(n, decimals) {
  if (!Number.isFinite(n)) return 0;
  const f = Math.pow(10, decimals || 0);
  return Math.round(n * f) / f;
}

/* ------------------------------------------------------------------ *
 * CLI.
 * ------------------------------------------------------------------ */

function main(args) {
  const dataDir = args.includes('--data-dir') ? args[args.indexOf('--data-dir') + 1] : process.cwd();

  const result = analyze(dataDir);

  console.log('CHECKPOINT 30 ANALYSIS');
  console.log('Status:', result.status);
  console.log('Sample Count:', result.sampleCount, '/', result.required);
  console.log('Code Version:', result.codeVersion);
  console.log('Analysis Version:', result.analysisVersion);

  if (result.status === 'CHECKPOINT_30_NOT_REACHED') {
    console.log('Reason:', result.reason);
    console.log('Total Observations:', result.totalObservations);
    console.log('Valid Observations:', result.validObservations);
    console.log('Excluded:', result.excludedObservations);
    process.exit(0);
  }

  // Full analysis output
  console.log('\nPrimary Statistics:');
  console.log('  Mean difference:', result.primary.mean);
  console.log('  Median difference:', result.primary.median);
  console.log('  Std deviation:', result.primary.standardDeviation);
  console.log('  V1 mean return:', result.primary.meanV1Return);
  console.log('  ATLAS mean return:', result.primary.meanATLASReturn);
  console.log('  Win rate diff:', result.primary.winRateDifference + '%');

  console.log('\nBootstrap:');
  console.log('  Mean:', result.bootstrap.mean);
  console.log('  95% CI:', '[' + result.bootstrap.ciLower + ', ' + result.bootstrap.ciUpper + ']');
  console.log('  Seed:', result.bootstrap.seed);

  console.log('\nEffect Size:');
  console.log('  Cohen\'s d:', result.effectSize.d);
  console.log('  Interpretation:', result.effectSize.interpretation);

  console.log('\nStatistical Test:');
  console.log('  Test:', result.statisticalTest.testName);
  console.log('  p-value:', result.statisticalTest.pValue);
  console.log('  Conclusion:', result.statisticalTest.conclusion);

  console.log('\nEconomic Significance:');
  console.log('  Mean improvement:', result.economic.meanImprovement + '%');
  console.log('  ATLAS better:', result.economic.atlasBetterPct + '%');
  console.log('  Exceeds threshold:', result.economic.exceedsThreshold);

  console.log('\nCI Interpretation:', result.ciInterpretation.classification);
  console.log('Temporal Stability:', result.temporal.trend);
  console.log('Dataset Hash:', result.dataset.datasetHash);
  console.log('Promotion:', result.promotion.result);
  console.log('Auto-promoted:', result.promotion.automaticallyPromoted);

  // Reproducibility check
  const repro = reproducibilityCheck(dataDir, result);
  console.log('\nReproducibility:', repro.passed ? 'PASS' : 'FAIL');

  process.exit(0);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  analyze,
  reproducibilityCheck,
  loadData,
  validateMatchedSamples,
  duplicateAudit,
  lookAheadAudit,
  primaryStatistics,
  bootstrapAnalysis,
  effectSizeAnalysis,
  statisticalTestAnalysis,
  economicSignificance,
  interpretCI,
  regimeAnalysis,
  agentAttributionAnalysis,
  calibrationAnalysis,
  disagreementAnalysis,
  dataQualityAnalysis,
  temporalStability,
  createDatasetSnapshot,
  createSeededRng,
  seedFromHash,
  CODE_VERSION,
  ANALYSIS_VERSION,
  PRACTICAL_THRESHOLD_PCT
};
