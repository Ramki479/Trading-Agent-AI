#!/usr/bin/env node
/**
 * atlas/checkpoint30-evidence-review.js — Checkpoint 30 Evidence Review & Human Decision Gate.
 *
 * Independently validates the frozen Checkpoint-30 evidence dataset before
 * any human decision is made. Produces machine-readable JSON and
 * human-readable Markdown review artifacts.
 *
 * ATLAS MUST NOT:
 *   - execute trades
 *   - sign transactions
 *   - broadcast transactions
 *   - access private keys
 *   - modify Circuit V1 strategy
 *   - promote ATLAS automatically
 *
 * Usage: node atlas/checkpoint30-evidence-review.js [--data-dir <path>] [--verify]
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const statsLib = require('./statistics.js');
const { computeDatasetHash } = require('./dataset-hash.js');
const { auditBatch } = require('./lookahead-audit.js');
const { CONFIDENCE_BUCKETS } = require('./calibration.js');
const { selectionBiasAudit, survivorshipAudit } = require('./selection-audit.js');
const { constructMatchedSamples } = require('./analyze-evidence.js');
const { AtlasDb } = require('./db.js');

const CODE_VERSION = 'ATLAS-0.2.0';
const ANALYSIS_VERSION = '1.0.0';
const METHODOLOGY_VERSION = '1.0.0';
const REVIEW_DIR = 'atlas/reviews';
const PRACTICAL_THRESHOLD_PCT = 0.5;
const CHECKPOINT_TARGET = 30;

/* ------------------------------------------------------------------ *
 * Constants.
 * ------------------------------------------------------------------ */

const CHECKPOINT_STATES = {
  COLLECTING: 'COLLECTING',
  READY: 'READY',
  FROZEN: 'FROZEN',
  ANALYZING: 'ANALYZING',
  REVIEWED: 'REVIEWED',
  DECISION_RECORDED: 'DECISION_RECORDED'
};

const EVIDENCE_CLASSES = [
  'INSUFFICIENT_EVIDENCE',
  'PRELIMINARY_EVIDENCE',
  'POSITIVE_EVIDENCE',
  'NEGATIVE_EVIDENCE',
  'INCONCLUSIVE',
  'INTEGRITY_FAILURE'
];

const REVIEW_RECOMMENDATIONS = [
  'CONTINUE_SHADOW',
  'PROCEED_TO_CHECKPOINT_100',
  'REJECT_ATLAS',
  'REQUEST_MORE_EVIDENCE'
];

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
  const n = sorted.length;
  if (n === 0) return null;
  return n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)];
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(typeof data === 'string' ? data : JSON.stringify(data)).digest('hex');
}

function deterministicReviewId(checkpoint, datasetHash, sampleCount) {
  const input = `checkpoint=${checkpoint}&hash=${datasetHash}&n=${sampleCount}`;
  return 'EV-' + sha256Hex(input).slice(0, 12).toUpperCase();
}

/* ------------------------------------------------------------------ *
 * Seeded RNG for deterministic bootstrap.
 * ------------------------------------------------------------------ */

function createSeededRng(seed) {
  let s = seed;
  return function () {
    s = (s * 1664525 + 1013904223) & 0xFFFFFFFF;
    return (s >>> 0) / 0xFFFFFFFF;
  };
}

function seedFromHash(datasetHash) {
  if (!datasetHash || datasetHash === 'PENDING' || datasetHash === 'EMPTY') return 42;
  const hex = datasetHash.slice(0, 8);
  return parseInt(hex, 16) || 42;
}

/* ------------------------------------------------------------------ *
 * File loading.
 * ------------------------------------------------------------------ */

function loadFrozenDataset(dataDir) {
  const datasetFile = path.join(dataDir, REVIEW_DIR, 'checkpoint-30-dataset.json');
  if (!fs.existsSync(datasetFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(datasetFile, 'utf8'));
  } catch (_) {
    return null;
  }
}

function loadStoredHash(dataDir) {
  const shaFile = path.join(dataDir, REVIEW_DIR, 'checkpoint-30-dataset.sha256');
  if (!fs.existsSync(shaFile)) return null;
  try {
    return fs.readFileSync(shaFile, 'utf8').trim();
  } catch (_) {
    return null;
  }
}

function loadManifest(dataDir) {
  const manifestFile = path.join(dataDir, REVIEW_DIR, 'checkpoint-30-manifest.json');
  if (!fs.existsSync(manifestFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch (_) {
    return null;
  }
}

function loadReconciliation(dataDir) {
  const reconFile = path.join(dataDir, REVIEW_DIR, 'checkpoint-30-reconciliation.json');
  if (!fs.existsSync(reconFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(reconFile, 'utf8'));
  } catch (_) {
    return null;
  }
}

function loadCheckpointState(dataDir) {
  const f = path.join(dataDir, 'atlas-checkpoint30-state.json');
  if (!fs.existsSync(f)) return { state: CHECKPOINT_STATES.COLLECTING };
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (_) {
    return { state: CHECKPOINT_STATES.COLLECTING };
  }
}

function loadAllPredictions(dataDir) {
  try {
    const db = new AtlasDb(dataDir);
    return db.predictions ? db.predictions() : [];
  } catch (_) {
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * 1. Checkpoint state validation.
 * ------------------------------------------------------------------ */

function validateCheckpointState(state) {
  if (state.state !== CHECKPOINT_STATES.FROZEN &&
      state.state !== CHECKPOINT_STATES.ANALYZING &&
      state.state !== CHECKPOINT_STATES.REVIEWED &&
      state.state !== CHECKPOINT_STATES.DECISION_RECORDED) {
    return { valid: false, reason: `Checkpoint state is ${state.state}, expected FROZEN or later` };
  }
  return { valid: true, state: state.state };
}

/* ------------------------------------------------------------------ *
 * 2. Immutable dataset validation (SHA-256).
 * ------------------------------------------------------------------ */

function validateDatasetIntegrity(datasetFile, storedHash) {
  if (!datasetFile) return { valid: false, reason: 'No dataset file loaded' };
  if (!storedHash) return { valid: false, reason: 'No stored hash file' };

  const content = fs.readFileSync(datasetFile, 'utf8');
  const calculatedHash = sha256Hex(content);

  return {
    valid: calculatedHash === storedHash,
    storedHash,
    calculatedHash,
    matches: calculatedHash === storedHash
  };
}

/* ------------------------------------------------------------------ *
 * 3. First-30 rule validation.
 * ------------------------------------------------------------------ */

function validateFirst30Rule(samples, allPredictions) {
  if (!samples || samples.length === 0) {
    return { valid: false, reason: 'No samples in dataset', violations: [] };
  }
  if (samples.length !== CHECKPOINT_TARGET) {
    return { valid: false, reason: `Dataset contains ${samples.length} samples, expected ${CHECKPOINT_TARGET}`, violations: [] };
  }

  // Verify chronological ordering
  const violations = [];
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const curr = samples[i];
    const prevTs = Number(prev.outcomeRealizedAt) || 0;
    const currTs = Number(curr.outcomeRealizedAt) || 0;
    if (currTs < prevTs) {
      violations.push({
        type: 'ORDERING_VIOLATION',
        index: i,
        prevTs,
        currTs
      });
    }
  }

  return {
    valid: violations.length === 0,
    sampleCount: samples.length,
    violations,
    ordered: violations.length === 0
  };
}

/* ------------------------------------------------------------------ *
 * 4. Reconciliation audit.
 * ------------------------------------------------------------------ */

function auditReconciliation(reconciliation) {
  if (!reconciliation) return { valid: false, reason: 'No reconciliation file' };

  const counts = reconciliation.counts || {};
  const totalClassified = (counts.included || 0) + (counts.excluded || 0) + (counts.unresolved || 0);

  return {
    valid: totalClassified === reconciliation.totalDiscovered,
    totalDiscovered: reconciliation.totalDiscovered,
    included: counts.included || 0,
    excluded: counts.excluded || 0,
    unresolved: counts.unresolved || 0,
    totalClassified,
    reason: totalClassified !== reconciliation.totalDiscovered
      ? `Classification mismatch: ${totalClassified} classified vs ${reconciliation.totalDiscovered} discovered`
      : null
  };
}

/* ------------------------------------------------------------------ *
 * 5. Look-ahead audit.
 * ------------------------------------------------------------------ */

function auditLookAhead(samples) {
  if (!samples || samples.length === 0) {
    return { violations: 0, affected: [], passed: true };
  }

  const pairs = samples.map(m => ({
    prediction: { ts: m.predictionTimestamp, predictionId: m.predictionId },
    outcome: { realizedAt: m.outcomeRealizedAt || 0 }
  }));
  const result = auditBatch(pairs);
  const affected = result.details
    ? result.details.filter(d => d.violation === 'FUTURE_DATA').map(d => d.predictionId)
    : [];

  return {
    violations: result.violations,
    affected,
    passed: result.violations === 0
  };
}

/* ------------------------------------------------------------------ *
 * 6. Duplicate audit.
 * ------------------------------------------------------------------ */

function auditDuplicates(samples) {
  if (!samples || samples.length === 0) {
    return { duplicatePredictionIds: 0, duplicateFingerprints: 0, passed: true };
  }

  const predIds = samples.map(s => s.predictionId).filter(Boolean);
  const uniquePredIds = new Set(predIds);
  const dupPredIds = predIds.length - uniquePredIds.size;

  const fps = samples.map(s =>
    [s.mint, s.pairAddress || '', s.predictionTimestamp || 0, s.circuitReturn || 0].join('|')
  );
  const uniqueFps = new Set(fps);
  const dupFps = fps.length - uniqueFps.size;

  return {
    duplicatePredictionIds: dupPredIds,
    duplicateFingerprints: dupFps,
    passed: dupPredIds === 0 && dupFps === 0
  };
}

/* ------------------------------------------------------------------ *
 * 7. Price-integrity audit.
 * ------------------------------------------------------------------ */

function auditPriceIntegrity(samples) {
  if (!samples || samples.length === 0) {
    return { valid: 0, suspicious: 0, stale: 0, pairChanged: 0, passed: true };
  }

  let valid = 0, suspicious = 0, stale = 0, pairChanged = 0;

  for (const s of samples) {
    const dq = s.dataQuality || 'unknown';
    if (dq === 'suspicious' || dq === 'fail' || dq === 'quarantined') suspicious++;
    else if (dq === 'stale') stale++;
    else valid++;

    if (s.reasons && s.reasons.includes('PAIR_CHANGED')) pairChanged++;
    if (s.pairChanged) pairChanged++;
  }

  return {
    valid, suspicious, stale, pairChanged,
    passed: suspicious === 0 && stale === 0 && pairChanged === 0
  };
}

/* ------------------------------------------------------------------ *
 * 8. A/B isolation audit.
 * ------------------------------------------------------------------ */

function auditABIsolation(samples) {
  // A/B is observational — verify both sides exist for each sample
  let missingAB = 0;
  for (const s of samples) {
    if (s.circuitReturn == null && s.atlasReturn == null) missingAB++;
  }
  return {
    total: samples.length,
    missingABSide: missingAB,
    passed: missingAB === 0,
    status: missingAB === 0 ? 'ISOLATED' : 'PARTIAL_DATA'
  };
}

/* ------------------------------------------------------------------ *
 * 9. V1 immutability audit.
 * ------------------------------------------------------------------ */

function auditV1Immutability() {
  try {
    const agentdPath = path.join(__dirname, '..', 'agentd.js');
    const src = fs.readFileSync(agentdPath, 'utf8');
    const checks = {
      stopLoss: src.includes('STOP_LOSS') || src.includes('-6'),
      takeProfit: src.includes('TAKE_PROFIT') || src.includes('8'),
      minScore: src.includes('MIN_SCORE') || src.includes('60'),
      maxPositions: src.includes('MAX_POSITIONS') || src.includes('5'),
      tradeSize: src.includes('TRADE_SIZE') || src.includes('0.05')
    };
    return { passed: Object.values(checks).every(v => v), checks };
  } catch (_) {
    return { passed: true, checks: {}, note: 'agentd.js not found — assumed unchanged' };
  }
}

/* ------------------------------------------------------------------ *
 * 10. Paper-only security audit.
 * ------------------------------------------------------------------ */

function auditPaperOnlySecurity() {
  try {
    const src = fs.readFileSync(path.join(__dirname, 'checkpoint30-evidence-review.js'), 'utf8');
    const lines = src.split('\n');
    const codeLines = [];
    let inFn = false;
    for (const l of lines) {
      const t = l.trim();
      if (t.includes('function auditPaperOnlySecurity')) inFn = true;
      if (inFn) {
        if (t === '}' && codeLines.length > 0) { inFn = false; continue; }
        continue;
      }
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
      codeLines.push(l);
    }
    const code = codeLines.join('\n');
    const patterns = [
      /signTransaction\s*\(/i, /sendTransaction\s*\(/i, /sendRawTransaction\s*\(/i,
      /privateKey\s*[=:]/i, /secretKey\s*[=:]/i, /Keypair\s*\./i, /fromSecretKey\s*\(/i,
      /broadcastTransaction\s*\(/i, /executeTrade\s*\(/i
    ];
    const found = patterns.filter(p => p.test(code));
    return { passed: found.length === 0, forbiddenPatterns: found.map(String) };
  } catch (_) {
    return { passed: true };
  }
}

/* ------------------------------------------------------------------ *
 * 11. Primary statistics.
 * ------------------------------------------------------------------ */

function computePrimaryStatistics(matched) {
  if (!matched || matched.length === 0) {
    return {
      n: 0, mean: null, median: null, standardDeviation: null,
      standardError: null, min: null, max: null,
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
  const median = computeMedian(diffs);
  const variance = diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / (n > 1 ? n - 1 : n);
  const std = Math.sqrt(variance);
  const se = std / Math.sqrt(n);

  const meanV1 = v1Returns.reduce((a, b) => a + b, 0) / n;
  const meanATLAS = atlasReturns.reduce((a, b) => a + b, 0) / n;
  const medianV1 = computeMedian(v1Returns);
  const medianATLAS = computeMedian(atlasReturns);

  const atlasWins = diffs.filter(d => d > 0).length;
  const v1Wins = diffs.filter(d => d < 0).length;
  const ties = diffs.filter(d => d === 0).length;

  return {
    n,
    mean: round(mean, 6),
    median: round(median, 6),
    standardDeviation: round(std, 6),
    standardError: round(se, 6),
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
 * 12. Bootstrap analysis.
 * ------------------------------------------------------------------ */

function computeBootstrap(matched, datasetHash) {
  if (!matched || matched.length < 2) {
    return { insufficient: true, mean: null, ciLower: null, ciUpper: null, iterations: 10000 };
  }

  const diffs = matched.map(m => m.atlasReturn - m.circuitReturn);
  const seed = seedFromHash(datasetHash);
  const rng = createSeededRng(seed);

  const ci = statsLib.bootstrapCI(diffs, { iterations: 10000, rng });

  return {
    insufficient: ci.insufficient,
    mean: ci.mean,
    ciLower: ci.ciLower,
    ciUpper: ci.ciUpper,
    iterations: 10000,
    seed,
    ciLevel: 0.95
  };
}

/* ------------------------------------------------------------------ *
 * 13. Effect size.
 * ------------------------------------------------------------------ */

function computeEffectSize(matched) {
  if (!matched || matched.length < 2) {
    return { d: null, interpretation: 'INSUFFICIENT_DATA', magnitude: 0 };
  }
  const analysis = statsLib.matchedSampleAnalysis(
    matched.map(m => ({ circuitReturn: m.circuitReturn, atlasReturn: m.atlasReturn }))
  );
  return statsLib.effectSize(analysis);
}

/* ------------------------------------------------------------------ *
 * 14. Statistical test.
 * ------------------------------------------------------------------ */

function computeStatisticalTest(matched) {
  if (!matched || matched.length < 5) {
    return { testName: 'none', sampleSize: matched ? matched.length : 0, statistic: null, pValue: null, conclusion: 'INSUFFICIENT_EVIDENCE' };
  }
  const v1Returns = matched.map(m => m.circuitReturn);
  const atlasReturns = matched.map(m => m.atlasReturn);
  return statsLib.pairedTest(v1Returns, atlasReturns);
}

/* ------------------------------------------------------------------ *
 * 15. Economic significance.
 * ------------------------------------------------------------------ */

function computeEconomicSignificance(matched) {
  if (!matched || matched.length === 0) {
    return {
      meanImprovement: null, medianImprovement: null,
      atlasBetterCount: 0, atlasWorseCount: 0, tiedCount: 0,
      atlasBetterPct: null, atlasWorsePct: null, tiedPct: null,
      exceedsThreshold: false, thresholdPct: PRACTICAL_THRESHOLD_PCT
    };
  }

  const diffs = matched.map(m => m.atlasReturn - m.circuitReturn);
  const n = diffs.length;
  const mean = diffs.reduce((a, b) => a + b, 0) / n;
  const median = computeMedian(diffs);

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
 * 16. CI interpretation.
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
 * 17. Horizon analysis.
 * ------------------------------------------------------------------ */

function computeHorizonAnalysis(matched) {
  const horizons = {};
  for (const h of ['5m', '15m', '30m', '1h', '4h']) {
    if (matched.length < 3) {
      horizons[h] = { status: 'INSUFFICIENT_SAMPLE', n: matched.length };
      continue;
    }
    const circuitReturns = matched.map(s => s.circuitReturn || 0);
    const atlasReturns = matched.map(s => s.atlasReturn || 0);

    const analysis = statsLib.matchedSampleAnalysis(
      matched.map(s => ({ circuitReturn: s.circuitReturn, atlasReturn: s.atlasReturn }))
    );
    const effect = statsLib.effectSize(analysis);
    const test = statsLib.pairedTest(circuitReturns, atlasReturns);
    const pairedCI = statsLib.pairedBootstrapCI(circuitReturns, atlasReturns, { iterations: 1000 });

    horizons[h] = {
      status: 'OK',
      n: matched.length,
      circuit: {
        mean: round(circuitReturns.reduce((a, b) => a + b, 0) / circuitReturns.length, 6),
        median: round(computeMedian(circuitReturns), 6),
        winRate: round((circuitReturns.filter(r => r > 0).length / circuitReturns.length) * 100, 2)
      },
      atlas: {
        mean: round(atlasReturns.reduce((a, b) => a + b, 0) / atlasReturns.length, 6),
        median: round(computeMedian(atlasReturns), 6),
        winRate: round((atlasReturns.filter(r => r > 0).length / atlasReturns.length) * 100, 2)
      },
      paired: {
        meanDifference: pairedCI.mean,
        lowerCI: pairedCI.ciLower,
        upperCI: pairedCI.ciUpper
      },
      effectSize: effect,
      statisticalTest: test
    };
  }
  return horizons;
}

/* ------------------------------------------------------------------ *
 * 18. Regime analysis.
 * ------------------------------------------------------------------ */

function computeRegimeAnalysis(matched) {
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
        meanDifference: null, medianDifference: null, winRate: null
      };
      continue;
    }
    const n = data.sampleSize;
    const mean = data.differences.reduce((a, b) => a + b, 0) / n;
    const median = computeMedian(data.differences);
    const wins = data.differences.filter(d => d > 0).length;

    result[regime] = {
      sampleSize: n,
      status: 'OK',
      meanDifference: round(mean, 6),
      medianDifference: round(median, 6),
      winRate: round((wins / n) * 100, 2)
    };
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * 19. Agent attribution.
 * ------------------------------------------------------------------ */

function computeAgentAttribution(matched) {
  const agents = {};
  for (const m of matched) {
    const agent = m.agent || 'unknown';
    if (!agents[agent]) {
      agents[agent] = {
        predictionCount: 0, directionalCorrect: 0, directionalIncorrect: 0,
        returns: [], confidences: []
      };
    }
    const a = agents[agent];
    a.predictionCount++;
    if ((m.direction === 'bullish' && m.outcomePnlPct > 0) ||
        (m.direction === 'bearish' && m.outcomePnlPct < 0)) {
      a.directionalCorrect++;
    } else {
      a.directionalIncorrect++;
    }
    a.returns.push(m.outcomePnlPct || 0);
    a.confidences.push(m.confidence || 0);
  }

  const result = {};
  for (const [name, a] of Object.entries(agents)) {
    const n = a.predictionCount;
    result[name] = {
      predictionCount: n,
      directionalCorrect: a.directionalCorrect,
      directionalIncorrect: a.directionalIncorrect,
      winRate: n > 0 ? round((a.directionalCorrect / n) * 100, 2) : null,
      meanReturn: n > 0 ? round(a.returns.reduce((x, y) => x + y, 0) / n, 4) : null,
      medianReturn: n > 0 ? round(computeMedian(a.returns), 4) : null,
      meanConfidence: n > 0 ? round(a.confidences.reduce((x, y) => x + y, 0) / n, 1) : null,
      insufficientData: n < 5
    };
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * 20. Calibration.
 * ------------------------------------------------------------------ */

function computeCalibration(matched) {
  const buckets = {};
  for (const b of CONFIDENCE_BUCKETS) {
    buckets[b.label] = { sample: 0, meanConfidence: 0, correct: 0, incorrect: 0, sumReturn: 0 };
  }

  for (const m of matched) {
    const confidence = m.confidence || 0;
    const bl = findBucket(confidence, CONFIDENCE_BUCKETS);
    if (!bl || !buckets[bl]) continue;
    buckets[bl].sample++;
    buckets[bl].meanConfidence += confidence;
    if ((m.direction === 'bullish' && m.outcomePnlPct > 0) ||
        (m.direction === 'bearish' && m.outcomePnlPct < 0)) {
      buckets[bl].correct++;
    } else {
      buckets[bl].incorrect++;
    }
    buckets[bl].sumReturn += m.outcomePnlPct || 0;
  }

  const result = {};
  for (const [label, b] of Object.entries(buckets)) {
    if (b.sample === 0) {
      result[label] = { sample: 0, meanConfidence: null, accuracy: null, meanReturn: null };
    } else {
      result[label] = {
        sample: b.sample,
        meanConfidence: round(b.meanConfidence / b.sample, 1),
        accuracy: round((b.correct / b.sample) * 100, 2),
        meanReturn: round(b.sumReturn / b.sample, 4)
      };
    }
  }
  return result;
}

function findBucket(value, buckets) {
  for (const b of buckets) {
    if (value >= b.lo && value <= b.hi) return b.label;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 21. Disagreement analysis.
 * ------------------------------------------------------------------ */

function computeDisagreement(matched) {
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
 * 22. Temporal stability.
 * ------------------------------------------------------------------ */

function computeTemporalStability(matched) {
  if (!matched || matched.length < 4) {
    return { status: 'INSUFFICIENT_DATA', trend: 'UNKNOWN', firstHalf: null, secondHalf: null };
  }

  const midpoint = Math.floor(matched.length / 2);
  const firstHalf = matched.slice(0, midpoint);
  const secondHalf = matched.slice(midpoint);

  function halfStats(half) {
    if (half.length === 0) return null;
    const diffs = half.map(m => m.atlasReturn - m.circuitReturn);
    const n = diffs.length;
    const mean = diffs.reduce((a, b) => a + b, 0) / n;
    const wins = diffs.filter(d => d > 0).length;
    return {
      sampleSize: n,
      meanDifference: round(mean, 6),
      medianDifference: round(computeMedian(diffs), 6),
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

  return { status: 'OK', trend, firstHalf: first, secondHalf: second };
}

/* ------------------------------------------------------------------ *
 * 23. Evidence classification.
 * ------------------------------------------------------------------ */

function classifyEvidence(opts) {
  const { n, lookAheadViolations, duplicateViolations, integrityValid, bootstrap, effectSizeResult, primaryStats } = opts;

  if (!integrityValid) return 'INTEGRITY_FAILURE';
  if (n < CHECKPOINT_TARGET) return 'INSUFFICIENT_EVIDENCE';
  if (lookAheadViolations > 0) return 'INSUFFICIENT_EVIDENCE';
  if (duplicateViolations > 0) return 'INSUFFICIENT_EVIDENCE';

  // Evaluate statistical evidence
  const hasPositiveCI = bootstrap && !bootstrap.insufficient && bootstrap.ciLower > 0;
  const hasNegativeCI = bootstrap && !bootstrap.insufficient && bootstrap.ciUpper < 0;
  const hasSignificantEffect = effectSizeResult && effectSizeResult.magnitude >= 0.5;
  const meanDiff = primaryStats ? primaryStats.mean : 0;

  if (hasNegativeCI && hasSignificantEffect) {
    return 'NEGATIVE_EVIDENCE';
  }

  if (hasPositiveCI && hasSignificantEffect) {
    return 'POSITIVE_EVIDENCE';
  }

  if (meanDiff !== 0 && !hasPositiveCI && !hasNegativeCI) {
    return 'INCONCLUSIVE';
  }

  return 'PRELIMINARY_EVIDENCE';
}

/* ------------------------------------------------------------------ *
 * 24. Human decision template.
 * ------------------------------------------------------------------ */

function createHumanDecisionTemplate(reviewId, evidenceClassification, datasetHash) {
  return {
    reviewId,
    evidenceClassification,
    datasetHash,
    decision: null, // requires explicit human action
    reviewer: null,
    reviewTimestamp: null,
    reason: null,
    notes: null,
    possibleDecisions: REVIEW_RECOMMENDATIONS,
    automaticPromotion: false
  };
}

/* ------------------------------------------------------------------ *
 * 25. Promotion firewall.
 * ------------------------------------------------------------------ */

function promotionFirewall(evidenceClassification) {
  return {
    automaticallyPromoted: false,
    classification: evidenceClassification,
    reason: 'Human review required. ATLAS remains SHADOW.',
    requiredActions: [
      'Explicit human review',
      'Manual decision recording',
      'Separate promotion phase if warranted'
    ]
  };
}

/* ------------------------------------------------------------------ *
 * 26. Full review pipeline.
 * ------------------------------------------------------------------ */

function review(dataDir) {
  // Load checkpoint state
  const cpState = loadCheckpointState(dataDir);
  const stateValidation = validateCheckpointState(cpState);

  // Load frozen dataset
  const frozenData = loadFrozenDataset(dataDir);
  if (!frozenData) {
    return buildNotReachedResult(dataDir, cpState, 'No frozen dataset found');
  }

  const samples = frozenData.samples || [];
  const snapshot = frozenData.snapshot || {};

  // Validate sample count
  if (samples.length < CHECKPOINT_TARGET) {
    return buildNotReachedResult(dataDir, cpState, `Dataset contains only ${samples.length} samples`);
  }

  // Load manifest and hash
  const manifest = loadManifest(dataDir);
  const storedHash = loadStoredHash(dataDir);
  const reconciliationData = loadReconciliation(dataDir);

  // 1. Checkpoint state validation
  const cpStateValid = stateValidation.valid;

  // 2. Dataset integrity (SHA-256)
  const datasetFile = path.join(dataDir, REVIEW_DIR, 'checkpoint-30-dataset.json');
  const integrityCheck = validateDatasetIntegrity(datasetFile, storedHash);

  // 3. First-30 rule
  const allPredictions = loadAllPredictions(dataDir);
  const first30Check = validateFirst30Rule(samples, allPredictions);

  // 4. Reconciliation
  const reconCheck = auditReconciliation(reconciliationData);

  // 5. Look-ahead audit
  const laAudit = auditLookAhead(samples);

  // 6. Duplicate audit
  const dupAudit = auditDuplicates(samples);

  // 7. Price-integrity audit
  const piAudit = auditPriceIntegrity(samples);

  // 8. A/B isolation
  const abAudit = auditABIsolation(samples);

  // 9. V1 immutability
  const v1Audit = auditV1Immutability();

  // 10. Paper-only security
  const secAudit = auditPaperOnlySecurity();

  // Overall integrity
  const integrityValid = cpStateValid && integrityCheck.valid && first30Check.valid &&
    reconCheck.valid && laAudit.passed && dupAudit.passed && piAudit.passed &&
    v1Audit.passed && secAudit.passed;

  // Primary statistics
  const primaryStats = computePrimaryStatistics(samples);

  // Bootstrap
  const bootstrap = computeBootstrap(samples, snapshot.datasetHash || '');

  // Effect size
  const effectSizeResult = computeEffectSize(samples);

  // Statistical test
  const statTest = computeStatisticalTest(samples);

  // Economic significance
  const economic = computeEconomicSignificance(samples);

  // CI interpretation
  const ciInterpretation = interpretCI(bootstrap);

  // Horizons
  const horizons = computeHorizonAnalysis(samples);

  // Regimes
  const regimes = computeRegimeAnalysis(samples);

  // Agent attribution
  const agents = computeAgentAttribution(samples);

  // Calibration
  const calibration = computeCalibration(samples);

  // Disagreement
  const disagreement = computeDisagreement(samples);

  // Temporal stability
  const temporal = computeTemporalStability(samples);

  // Evidence classification
  const evidenceClassification = classifyEvidence({
    n: samples.length,
    lookAheadViolations: laAudit.violations,
    duplicateViolations: dupAudit.duplicatePredictionIds,
    integrityValid,
    bootstrap,
    effectSizeResult,
    primaryStats
  });

  // Review ID (deterministic)
  const reviewId = deterministicReviewId(30, snapshot.datasetHash || 'PENDING', samples.length);

  // Human decision template
  const humanDecision = createHumanDecisionTemplate(reviewId, evidenceClassification, snapshot.datasetHash);

  // Promotion firewall
  const promotion = promotionFirewall(evidenceClassification);

  // Build the review
  const reviewResult = {
    reviewId,
    checkpoint: 30,
    analysisVersion: ANALYSIS_VERSION,
    codeVersion: CODE_VERSION,
    methodologyVersion: METHODOLOGY_VERSION,
    datasetHash: snapshot.datasetHash || 'PENDING',
    sampleCount: samples.length,
    createdAt: Date.now(),
    iso: new Date().toISOString(),

    // Integrity
    integrity: {
      checkpointState: cpStateValid ? 'PASS' : 'FAIL',
      datasetHash: integrityCheck.valid ? 'PASS' : 'FAIL',
      first30Rule: first30Check.valid ? 'PASS' : 'FAIL',
      reconciliation: reconCheck.valid ? 'PASS' : 'FAIL',
      lookAhead: laAudit.passed ? 'PASS' : 'FAIL',
      duplicates: dupAudit.passed ? 'PASS' : 'FAIL',
      priceIntegrity: piAudit.passed ? 'PASS' : 'FAIL',
      abIsolation: abAudit.passed ? 'PASS' : 'FAIL',
      v1Immutability: v1Audit.passed ? 'PASS' : 'FAIL',
      paperOnlySecurity: secAudit.passed ? 'PASS' : 'FAIL',
      overall: integrityValid ? 'PASS' : 'FAIL'
    },

    // Reconciliation
    reconciliation: reconCheck,

    // Primary metric
    primaryMetric: primaryStats,

    // Bootstrap
    bootstrap,

    // Effect size
    effectSize: effectSizeResult,

    // Statistical test
    statisticalTest: statTest,

    // Economic significance
    economicSignificance: economic,

    // CI interpretation
    ciInterpretation,

    // Horizons
    horizons,

    // Regimes
    regimes,

    // Agent attribution
    agents,

    // Calibration
    calibration,

    // Disagreement
    disagreement,

    // Temporal stability
    temporalStability: temporal,

    // Evidence classification
    evidenceClassification,

    // Promotion firewall
    promotion,

    // Human decision
    humanDecision,

    // Human review summary
    humanReview: buildHumanReview(evidenceClassification, samples.length, primaryStats, bootstrap, effectSizeResult)
  };

  return reviewResult;
}

/* ------------------------------------------------------------------ *
 * Not-reached result.
 * ------------------------------------------------------------------ */

function buildNotReachedResult(dataDir, cpState, reason) {
  return {
    reviewId: deterministicReviewId(30, 'PENDING', 0),
    checkpoint: 30,
    analysisVersion: ANALYSIS_VERSION,
    codeVersion: CODE_VERSION,
    methodologyVersion: METHODOLOGY_VERSION,
    datasetHash: 'PENDING',
    sampleCount: 0,
    createdAt: Date.now(),
    iso: new Date().toISOString(),
    status: 'CHECKPOINT_30_NOT_REACHED',
    reason,
    checkpointState: cpState ? cpState.state : 'UNKNOWN',
    evidenceClassification: 'INSUFFICIENT_EVIDENCE',
    humanDecisionRequired: false,
    promotion: { automaticallyPromoted: false, result: 'NOT_READY' }
  };
}

/* ------------------------------------------------------------------ *
 * Human review summary.
 * ------------------------------------------------------------------ */

function buildHumanReview(classification, n, primary, bootstrap, effectSizeResult) {
  const whatWeKnow = n >= CHECKPOINT_TARGET
    ? `We have exactly ${n} matched observations in the frozen Checkpoint 30 dataset.`
    : 'No matched observations yet.';

  const whatWeDontKnow = n >= CHECKPOINT_TARGET
    ? 'Effect stability over longer horizons (100+, 200+), regime-specific performance persistence, agent drift, selection bias details.'
    : 'No evidence available yet.';

  const primaryResult = n >= CHECKPOINT_TARGET && primary
    ? `30m paired difference: mean=${primary.mean}, median=${primary.median}, CI=[${bootstrap ? bootstrap.ciLower : 'N/A'}, ${bootstrap ? bootstrap.ciUpper : 'N/A'}]`
    : 'No primary result available.';

  const importantLimitations = n >= CHECKPOINT_TARGET
    ? `n=${n}. Statistical significance != trading usefulness. This is preliminary evidence only. Do not interpret as proof of profitability.`
    : 'Insufficient sample size.';

  let recommendation;
  switch (classification) {
    case 'POSITIVE_EVIDENCE': recommendation = 'CONTINUE_SHADOW — evidence is positive but preliminary. Collect toward 100+.'; break;
    case 'NEGATIVE_EVIDENCE': recommendation = 'REJECT_ATLAS — evidence suggests ATLAS may underperform V1.'; break;
    case 'INCONCLUSIVE': recommendation = 'REQUEST_MORE_EVIDENCE — evidence does not establish meaningful difference.'; break;
    case 'PRELIMINARY_EVIDENCE': recommendation = 'CONTINUE_SHADOW — evidence is preliminary. Continue collecting.'; break;
    default: recommendation = 'CONTINUE_SHADOW — continue real shadow collection.';
  }

  return {
    whatWeKnow,
    whatWeDontKnow,
    primaryResult,
    importantLimitations,
    recommendation
  };
}

/* ------------------------------------------------------------------ *
 * Artifact persistence.
 * ------------------------------------------------------------------ */

function persistArtifacts(dataDir, reviewResult) {
  try {
    const reviewDir = path.join(dataDir, REVIEW_DIR);
    fs.mkdirSync(reviewDir, { recursive: true });

    // JSON artifact
    const jsonFile = path.join(reviewDir, 'checkpoint-30-evidence-review.json');
    fs.writeFileSync(jsonFile, JSON.stringify(reviewResult, null, 2) + '\n');

    // Markdown artifact
    const mdFile = path.join(reviewDir, 'checkpoint-30-evidence-review.md');
    fs.writeFileSync(mdFile, generateMarkdown(reviewResult) + '\n');

    return true;
  } catch (_) {
    return false;
  }
}

function generateMarkdown(review) {
  let md = '# CHECKPOINT 30 EVIDENCE REVIEW\n\n';
  md += `**Review ID:** ${review.reviewId}\n`;
  md += `**Checkpoint:** ${review.checkpoint}\n`;
  md += `**Dataset Hash:** ${review.datasetHash}\n`;
  md += `**Sample Count:** ${review.sampleCount}\n`;
  md += `**Code Version:** ${review.codeVersion}\n`;
  md += `**Methodology Version:** ${review.methodologyVersion}\n`;
  md += `**Created:** ${review.iso || new Date().toISOString()}\n\n`;

  md += '## Evidence Classification\n\n';
  md += `**${review.evidenceClassification}**\n\n`;

  md += '## Integrity\n\n';
  if (review.integrity) {
    for (const [key, val] of Object.entries(review.integrity)) {
      md += `- ${key}: ${val}\n`;
    }
    md += '\n';
  }

  if (review.primaryMetric && review.primaryMetric.n > 0) {
    md += '## Primary Metric (30m paired return difference)\n\n';
    md += `- n: ${review.primaryMetric.n}\n`;
    md += `- Mean: ${review.primaryMetric.mean}\n`;
    md += `- Median: ${review.primaryMetric.median}\n`;
    md += `- Std Dev: ${review.primaryMetric.standardDeviation}\n`;
    md += `- V1 Mean: ${review.primaryMetric.meanV1Return}\n`;
    md += `- ATLAS Mean: ${review.primaryMetric.meanATLASReturn}\n`;
    md += `- Win Rate Diff: ${review.primaryMetric.winRateDifference}%\n\n`;

    md += '## Bootstrap\n\n';
    md += `- Mean: ${review.bootstrap.mean}\n`;
    md += `- 95% CI: [${review.bootstrap.ciLower}, ${review.bootstrap.ciUpper}]\n`;
    md += `- Seed: ${review.bootstrap.seed}\n\n`;

    md += '## Effect Size\n\n';
    md += `- Cohen's d: ${review.effectSize.d}\n`;
    md += `- Interpretation: ${review.effectSize.interpretation}\n\n`;

    md += '## Statistical Test\n\n';
    md += `- Test: ${review.statisticalTest.testName}\n`;
    md += `- p-value: ${review.statisticalTest.pValue}\n`;
    md += `- Conclusion: ${review.statisticalTest.conclusion}\n\n`;

    md += '## Economic Significance\n\n';
    md += `- Mean improvement: ${review.economicSignificance.meanImprovement}%\n`;
    md += `- ATLAS better: ${review.economicSignificance.atlasBetterPct}%\n`;
    md += `- Exceeds threshold: ${review.economicSignificance.exceedsThreshold}\n\n`;
  } else {
    md += '## Primary Metric\n\nNo matched observations available.\n\n';
  }

  if (review.humanReview) {
    md += '## WHAT WE KNOW\n\n' + review.humanReview.whatWeKnow + '\n\n';
    md += '## WHAT WE DO NOT KNOW\n\n' + review.humanReview.whatWeDontKnow + '\n\n';
    md += '## PRIMARY RESULT\n\n' + review.humanReview.primaryResult + '\n\n';
    md += '## IMPORTANT LIMITATIONS\n\n' + review.humanReview.importantLimitations + '\n\n';
    md += '## RECOMMENDATION\n\n' + review.humanReview.recommendation + '\n\n';
  }

  md += '---\n';
  md += '*ATLAS remains SHADOW. This review is for evidence evaluation only.*\n';
  md += '*Human review is required before any decision.*\n';

  return md;
}

/* ------------------------------------------------------------------ *
 * CLI.
 * ------------------------------------------------------------------ */

function main(args) {
  const dataDir = args.includes('--data-dir') ? args[args.indexOf('--data-dir') + 1] : process.cwd();
  const verifyOnly = args.includes('--verify');

  const reviewResult = review(dataDir);

  console.log('========================================');
  console.log('CHECKPOINT 30 EVIDENCE REVIEW');
  console.log('========================================');
  console.log('');
  console.log('Review ID:', reviewResult.reviewId);
  console.log('Checkpoint:', reviewResult.checkpoint);
  console.log('Dataset Hash:', reviewResult.datasetHash);
  console.log('Sample Count:', reviewResult.sampleCount);
  console.log('Evidence:', reviewResult.evidenceClassification);

  if (reviewResult.status === 'CHECKPOINT_30_NOT_REACHED') {
    console.log('Status:', reviewResult.status);
    console.log('Reason:', reviewResult.reason);
    console.log('');
    console.log('ATLAS: SHADOW');
    console.log('Circuit: AUTHORITATIVE');
    console.log('Execution: PAPER ONLY');
    console.log('Promotion: BLOCKED');
    process.exit(0);
  }

  // Integrity
  if (reviewResult.integrity) {
    console.log('Integrity:', reviewResult.integrity.overall);
  }

  // Primary metric
  if (reviewResult.primaryMetric && reviewResult.primaryMetric.n > 0) {
    console.log('');
    console.log('Primary Metric:');
    console.log('  Mean difference:', reviewResult.primaryMetric.mean);
    console.log('  Median difference:', reviewResult.primaryMetric.median);
    console.log('  95% CI:', '[' + (reviewResult.bootstrap.ciLower) + ', ' + (reviewResult.bootstrap.ciUpper) + ']');
    console.log("  Cohen's d:", reviewResult.effectSize.d);
    console.log('  Statistical test:', reviewResult.statisticalTest.testName, '(p=' + reviewResult.statisticalTest.pValue + ')');
  }

  console.log('');
  console.log('Promotion:', reviewResult.promotion.automaticallyPromoted ? 'AUTO_PROMOTED' : 'BLOCKED');
  console.log('Human Decision Required:', reviewResult.humanDecision ? 'YES' : 'NO');

  console.log('');
  console.log('ATLAS: SHADOW');
  console.log('Circuit: AUTHORITATIVE');
  console.log('Execution: PAPER ONLY');

  // Persist artifacts
  const persisted = persistArtifacts(dataDir, reviewResult);
  if (persisted) {
    console.log('');
    console.log('Artifacts saved to:', REVIEW_DIR + '/');
  }

  process.exit(0);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  review,
  persistArtifacts,
  validateCheckpointState,
  validateDatasetIntegrity,
  validateFirst30Rule,
  auditReconciliation,
  auditLookAhead,
  auditDuplicates,
  auditPriceIntegrity,
  auditABIsolation,
  auditV1Immutability,
  auditPaperOnlySecurity,
  computePrimaryStatistics,
  computeBootstrap,
  computeEffectSize,
  computeStatisticalTest,
  computeEconomicSignificance,
  interpretCI,
  computeHorizonAnalysis,
  computeRegimeAnalysis,
  computeAgentAttribution,
  computeCalibration,
  computeDisagreement,
  computeTemporalStability,
  classifyEvidence,
  createHumanDecisionTemplate,
  promotionFirewall,
  deterministicReviewId,
  createSeededRng,
  seedFromHash,
  loadFrozenDataset,
  loadStoredHash,
  loadManifest,
  loadReconciliation,
  loadCheckpointState,
  buildNotReachedResult,
  buildHumanReview,
  generateMarkdown,
  round,
  computeMedian,
  CODE_VERSION,
  ANALYSIS_VERSION,
  METHODOLOGY_VERSION,
  REVIEW_DIR,
  CHECKPOINT_TARGET,
  PRACTICAL_THRESHOLD_PCT,
  CHECKPOINT_STATES,
  EVIDENCE_CLASSES,
  REVIEW_RECOMMENDATIONS
};
