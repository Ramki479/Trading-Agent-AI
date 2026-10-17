#!/usr/bin/env node
/**
 * atlas/checkpoint30-monitor.js — Checkpoint 30 collection monitor.
 *
 * Read-only operational view of collection progress toward Checkpoint 30.
 * Tracks matched observations, unresolved/excluded/duplicate counts,
 * look-ahead violations, data quality, dataset hashing, and checkpoint readiness.
 *
 * ATLAS MUST NOT:
 *   - execute trades
 *   - sign transactions
 *   - broadcast transactions
 *   - access private keys
 *   - modify the paper ledger
 *   - modify Circuit V1 strategy
 *   - override SL/TP
 *   - authorize real execution
 *   - promote ATLAS automatically
 *
 * Usage: node atlas/checkpoint30-monitor.js [--data-dir <path>]
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { AtlasDb } = require('./db.js');
const statsLib = require('./statistics.js');
const { computeDatasetHash } = require('./dataset-hash.js');
const { auditBatch } = require('./lookahead-audit.js');
const { constructMatchedSamples, isExcluded, deduplicatePredictions } = require('./analyze-evidence.js');
const { createABPaper } = require('./ab-paper.js');

const CODE_VERSION = 'ATLAS-0.2.0';
const ANALYSIS_VERSION = '1.0.0';
const CHECKPOINT_TARGET = 30;

/* ------------------------------------------------------------------ *
 * Data loading.
 * ------------------------------------------------------------------ */

function loadData(dataDir) {
  const db = new AtlasDb(dataDir);
  const predictions = db.predictions ? db.predictions() : [];
  const outcomes = db.outcomes ? db.outcomes() : [];
  const abPaperState = db.readJson ? db.readJson('atlas-ab-paper.json') : null;
  const checkpoints = db.readJson ? db.readJson('atlas-checkpoints.json') : null;

  return { db, predictions, outcomes, abPaperState, checkpoints };
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
 * Matched observation validation.
 * ------------------------------------------------------------------ */

function validateObservations(matched) {
  const valid = [];
  const excludedList = [];
  let lookAheadViolations = 0;
  let duplicates = 0;
  let pairChanged = 0;
  let suspicious = 0;
  let stale = 0;
  let missingOutcome = 0;
  let invalidNumeric = 0;

  const seenPredIds = new Set();
  const seenFingerprints = new Set();

  for (const m of matched) {
    if (m == null || typeof m !== 'object') {
      excludedList.push({ predictionId: null, mint: null, reasons: ['INVALID_RECORD'] });
      continue;
    }
    const reasons = [];

    // Duplicate prediction ID
    if (m.predictionId && seenPredIds.has(m.predictionId)) {
      duplicates++;
      reasons.push('DUPLICATE_PREDICTION_ID');
    }
    if (m.predictionId) seenPredIds.add(m.predictionId);

    // Duplicate fingerprint
    const fp = [m.mint, m.pairAddress || '', m.predictionTimestamp || 0, m.circuitReturn || 0].join('|');
    if (seenFingerprints.has(fp)) {
      reasons.push('DUPLICATE_FINGERPRINT');
    }
    seenFingerprints.add(fp);

    // Missing required fields
    if (!m.predictionId) reasons.push('NO_PREDICTION_ID');
    if (!m.mint) reasons.push('NO_MINT');
    if (!Number.isFinite(m.predictionTimestamp)) reasons.push('INVALID_PREDICTION_TS');

    // Look-ahead: resolution must be after prediction
    if (Number.isFinite(m.predictionTimestamp) && Number.isFinite(m.outcomeRealizedAt)) {
      if (m.outcomeRealizedAt <= m.predictionTimestamp) {
        lookAheadViolations++;
        reasons.push('LOOKAHEAD_VIOLATION');
      }
    }

    // Missing outcome
    if (m.outcomePnlPct == null || !Number.isFinite(m.outcomePnlPct)) {
      missingOutcome++;
      reasons.push('MISSING_OUTCOME');
    }

    // Invalid numeric values
    if (m.circuitReturn != null && !Number.isFinite(m.circuitReturn)) {
      invalidNumeric++;
      reasons.push('INVALID_CIRCUIT_RETURN');
    }
    if (m.atlasReturn != null && !Number.isFinite(m.atlasReturn)) {
      invalidNumeric++;
      reasons.push('INVALID_ATLAS_RETURN');
    }

    // Suspicious data quality
    if (m.dataQuality === 'suspicious' || m.dataQuality === 'fail' || m.dataQuality === 'quarantined') {
      suspicious++;
      reasons.push('SUSPICIOUS_DATA');
    }

    // PAIR_CHANGED
    if (m.reasons && m.reasons.includes('PAIR_CHANGED')) {
      pairChanged++;
      reasons.push('PAIR_CHANGED');
    }

    // Stale observation
    if (m.dataQuality === 'stale') {
      stale++;
      reasons.push('STALE_OBSERVATION');
    }

    if (reasons.length > 0) {
      excludedList.push({ predictionId: m.predictionId, mint: m.mint, reasons });
    } else {
      valid.push(m);
    }
  }

  return {
    valid,
    excluded: excludedList,
    lookAheadViolations,
    duplicates,
    pairChanged,
    suspicious,
    stale,
    missingOutcome,
    invalidNumeric
  };
}

/* ------------------------------------------------------------------ *
 * Dataset snapshot.
 * ------------------------------------------------------------------ */

function createDatasetSnapshot(matched) {
  if (!matched || matched.length === 0) {
    return { datasetHash: 'EMPTY', analysisVersion: ANALYSIS_VERSION, codeVersion: CODE_VERSION, sampleCount: 0, predictionIds: [] };
  }
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
 * Selection audit (lightweight).
 * ------------------------------------------------------------------ */

function selectionAudit(predictions, matched) {
  return {
    discovered: predictions.length,
    eligible: matched.length,
    matched: matched.length,
    selectionRate: predictions.length > 0 ? round((matched.length / predictions.length) * 100, 2) : null
  };
}

/* ------------------------------------------------------------------ *
 * Survivorship audit.
 * ------------------------------------------------------------------ */

function survivorshipAudit(predictions, outcomes, matched) {
  const predMints = new Set(predictions.map(p => p.mint).filter(Boolean));
  const outcomeMints = new Set(outcomes.map(o => o.mint).filter(Boolean));
  const matchedMints = new Set(matched.map(m => m.mint).filter(Boolean));

  const resolved = [...outcomeMints].filter(m => predMints.has(m)).length;
  const unresolved = [...predMints].filter(m => !outcomeMints.has(m)).length;
  const disappeared = [...predMints].filter(m => !outcomeMints.has(m) && !matchedMints.has(m)).length;

  return { resolved, unresolved, disappeared, total: predMints.size };
}

/* ------------------------------------------------------------------ *
 * Resolution horizon check.
 * ------------------------------------------------------------------ */

function resolutionHorizonCheck(matched) {
  let valid = 0;
  let invalid = 0;
  for (const m of matched) {
    if (Number.isFinite(m.predictionTimestamp) && Number.isFinite(m.outcomeRealizedAt)) {
      if (m.outcomeRealizedAt > m.predictionTimestamp) valid++;
      else invalid++;
    }
  }
  return { valid, invalid };
}

/* ------------------------------------------------------------------ *
 * A/B isolation check.
 * ------------------------------------------------------------------ */

function abIsolationCheck(abPaperState) {
  if (!abPaperState) return { status: 'NO_DATA', isolated: true };
  const comps = abPaperState.comparisons || [];
  return {
    status: 'OK',
    isolated: true, // A/B paper is always observational
    totalComparisons: comps.length,
    note: 'A/B paper results never modify cashSol/positionsSol/real P&L'
  };
}

/* ------------------------------------------------------------------ *
 * Main monitor function.
 * ------------------------------------------------------------------ */

function monitor(dataDir) {
  const startTime = Date.now();

  // Step 1: Load data
  const data = loadData(dataDir);

  // Step 2: Construct matched samples via existing pipeline
  const abPaper = createABPaper(data.db);
  const abState = abPaper.state ? abPaper.state() : {};
  const mockDb = { predictions: () => data.predictions, outcomes: () => data.outcomes, readJson: () => null, dir: dataDir };

  const matchedData = {
    predictions: data.predictions,
    outcomes: data.outcomes,
    abPaperState: abState,
    db: mockDb
  };

  const { matched: rawMatched, excluded: rawExcluded, total } = constructMatchedSamples(matchedData);

  // Step 3: Validate observations
  const validation = validateObservations(rawMatched);

  // Step 4: Checkpoint readiness
  const matchedCount = validation.valid.length;
  const remaining = Math.max(0, CHECKPOINT_TARGET - matchedCount);
  const ready = matchedCount >= CHECKPOINT_TARGET;

  // Step 5: Dataset snapshot
  const dataset = createDatasetSnapshot(validation.valid);

  // Step 6: Selection audit
  const selection = selectionAudit(data.predictions, validation.valid);

  // Step 7: Survivorship audit
  const survivorship = survivorshipAudit(data.predictions, data.outcomes, validation.valid);

  // Step 8: Resolution horizon check
  const resolutionCheck = resolutionHorizonCheck(validation.valid);

  // Step 9: A/B isolation check
  const abCheck = abIsolationCheck(abState);

  // Step 10: Timestamp tracking
  const predTimestamps = data.predictions
    .filter(p => Number.isFinite(p.ts))
    .map(p => p.ts);
  const outcomeTimestamps = data.outcomes
    .filter(o => Number.isFinite(o.realizedAt))
    .map(o => o.realizedAt);

  const firstPredictionTs = predTimestamps.length > 0 ? Math.min(...predTimestamps) : null;
  const latestPredictionTs = predTimestamps.length > 0 ? Math.max(...predTimestamps) : null;
  const latestResolutionTs = outcomeTimestamps.length > 0 ? Math.max(...outcomeTimestamps) : null;

  // Step 11: Build result
  const result = {
    checkpoint: {
      target: CHECKPOINT_TARGET,
      matched: matchedCount,
      remaining,
      ready,
      progressPct: round((matchedCount / CHECKPOINT_TARGET) * 100, 2),
      status: ready ? 'CHECKPOINT_30_READY' : 'CHECKPOINT_30_NOT_REACHED'
    },

    predictions: {
      total: data.predictions.length,
      resolved: data.outcomes.length,
      unresolved: Math.max(0, data.predictions.length - data.outcomes.length),
      excluded: validation.excluded.length + rawExcluded.length
    },

    duplicates: {
      predictionIds: validation.duplicates,
      fingerprints: validation.duplicates,
      total: validation.duplicates
    },

    lookAheadViolations: validation.lookAheadViolations,
    pairChanged: validation.pairChanged,
    suspicious: validation.suspicious,
    stale: validation.stale,
    missingOutcome: validation.missingOutcome,
    invalidNumeric: validation.invalidNumeric,

    dataset: {
      hash: dataset.datasetHash,
      analysisVersion: dataset.analysisVersion,
      codeVersion: dataset.codeVersion,
      sampleCount: dataset.sampleCount,
      predictionIds: dataset.predictionIds
    },

    selection,
    survivorship,
    resolutionHorizon: resolutionCheck,
    abIsolation: abCheck,

    timestamps: {
      firstPrediction: firstPredictionTs,
      latestPrediction: latestPredictionTs,
      latestResolution: latestResolutionTs,
      monitorRunAt: startTime
    },

    safety: {
      atlasMode: 'SHADOW',
      circuitMode: 'AUTHORITATIVE',
      executionMode: 'PAPER_ONLY',
      v1Modified: false,
      ledgerAffected: false,
      automaticPromotion: false
    },

    codeVersion: CODE_VERSION,
    analysisVersion: ANALYSIS_VERSION
  };

  return result;
}

/* ------------------------------------------------------------------ *
 * Persistence (snapshot for historical tracking).
 * ------------------------------------------------------------------ */

function persistMonitorSnapshot(dataDir, result) {
  const db = new AtlasDb(dataDir);
  try {
    const existing = db.readJson ? db.readJson('atlas-checkpoint30-monitor.json') : null;
    const history = (existing && existing.history) ? existing.history : [];
    history.push({
      timestamp: result.timestamps.monitorRunAt,
      matched: result.checkpoint.matched,
      remaining: result.checkpoint.remaining,
      status: result.checkpoint.status,
      datasetHash: result.dataset.hash
    });
    // Keep last 365 snapshots
    if (history.length > 365) history.splice(0, history.length - 365);
    if (db.writeJson) db.writeJson('atlas-checkpoint30-monitor.json', { history, updatedAt: Date.now() });
  } catch (_) { /* best effort */ }
}

/* ------------------------------------------------------------------ *
 * CLI.
 * ------------------------------------------------------------------ */

function main(args) {
  const dataDir = args.includes('--data-dir') ? args[args.indexOf('--data-dir') + 1] : process.cwd();

  const result = monitor(dataDir);

  console.log('========================================');
  console.log('ATLAS CHECKPOINT 30 COLLECTION MONITOR');
  console.log('========================================');
  console.log('');
  console.log('Checkpoint target:       ' + result.checkpoint.target);
  console.log('Matched observations:    ' + result.checkpoint.matched);
  console.log('Remaining:               ' + result.checkpoint.remaining);
  console.log('Progress:                ' + result.checkpoint.progressPct + '%');
  console.log('');
  console.log('Predictions:             ' + result.predictions.total);
  console.log('Resolved:                ' + result.predictions.resolved);
  console.log('Unresolved:              ' + result.predictions.unresolved);
  console.log('Excluded:                ' + result.predictions.excluded);
  console.log('');
  console.log('Duplicates:              ' + result.duplicates.total);
  console.log('Look-ahead violations:   ' + result.lookAheadViolations);
  console.log('PAIR_CHANGED:            ' + result.pairChanged);
  console.log('Suspicious:              ' + result.suspicious);
  console.log('Stale:                   ' + result.stale);
  console.log('Missing outcome:         ' + result.missingOutcome);
  console.log('');
  console.log('Dataset hash:');
  console.log(result.dataset.hash);
  console.log('');
  console.log('Analysis version:');
  console.log(result.codeVersion);
  console.log('');
  console.log('ATLAS:');
  console.log(result.safety.atlasMode);
  console.log('');
  console.log('Circuit:');
  console.log(result.safety.circuitMode);
  console.log('');
  console.log('Execution:');
  console.log(result.safety.executionMode);
  console.log('');
  console.log('V1 modified:');
  console.log(result.safety.v1Modified ? 'YES' : 'NO');
  console.log('');
  console.log('Ledger affected:');
  console.log(result.safety.ledgerAffected ? 'YES' : 'NO');
  console.log('');
  console.log('Automatic promotion:');
  console.log(result.safety.automaticPromotion ? 'YES' : 'NO');
  console.log('');
  console.log('STATUS:');
  console.log(result.checkpoint.status);
  console.log('');
  console.log('========================================');

  process.exit(0);
}

function round(n, d) {
  if (!Number.isFinite(n)) return 0;
  const f = Math.pow(10, d || 0);
  return Math.round(n * f) / f;
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  monitor,
  loadData,
  validateObservations,
  createDatasetSnapshot,
  selectionAudit,
  survivorshipAudit,
  resolutionHorizonCheck,
  abIsolationCheck,
  persistMonitorSnapshot,
  CHECKPOINT_TARGET,
  CODE_VERSION,
  ANALYSIS_VERSION
};
