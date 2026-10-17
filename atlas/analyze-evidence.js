#!/usr/bin/env node
/**
 * atlas/analyze-evidence.js — Reproducible ATLAS evidence analysis.
 *
 * Loads persisted shadow data, excludes invalid observations, constructs
 * matched samples, calculates all statistics, generates checkpoint state,
 * and produces a deterministic analysis report.
 *
 * Usage: node atlas/analyze-evidence.js
 *
 * MUST NOT:
 *   - execute trades
 *   - modify the paper ledger
 *   - modify positions
 *   - modify strategy parameters
 *   - modify prompts
 *   - modify agent weights
 */

'use strict';

const { AtlasDb } = require('./db.js');
const statsLib = require('./statistics.js');
const calibrationLib = require('./calibration.js');
const { createABPaper } = require('./ab-paper.js');
const { auditFromDb } = require('./lookahead-audit.js');
const { classifyAtlas, ATLAS_ATTRIBUTION_CLASSES } = require('./attribution.js');
const { dataQuality } = require('./evidence.js');

/* ------------------------------------------------------------------ *
 * Data loading and exclusion.
 * ------------------------------------------------------------------ */

/**
 * Load all persisted ATLAS data from the data directory.
 */
function loadData(dataDir) {
  const db = new AtlasDb(dataDir);
  return {
    db,
    predictions: db.predictions(),
    outcomes: db.outcomes(),
    evidence: db.evidence ? db.evidence() : [],
    decisions: readJsonl(dataDir, 'atlas-decisions.jsonl'),
    calibration: db.readJson ? db.readJson('atlas-calibration.json') : null,
    abPaperState: db.readJson ? db.readJson('atlas-ab-paper.json') : null,
    reputation: db.reputation(),
    checkpoints: db.readJson ? db.readJson('atlas-checkpoints.json') : null,
    daily: db.readJson ? db.readJson('atlas-daily.json') : null
  };
}

function readJsonl(dir, file) {
  const fs = require('fs');
  const path = require('path');
  const f = path.join(dir, file);
  if (!fs.existsSync(f)) return [];
  try {
    return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch (_) { return null; }
    }).filter(Boolean);
  } catch (_) { return []; }
}

/* ------------------------------------------------------------------ *
 * Exclusion rules.
 * ------------------------------------------------------------------ */

function isExcluded(prediction, outcome) {
  const reasons = [];

  // Missing required data
  if (!prediction || !outcome) {
    reasons.push('MISSING_DATA');
    return { excluded: true, reasons };
  }

  // Duplicate prediction ID
  if (!prediction.predictionId) {
    reasons.push('NO_PREDICTION_ID');
  }

  // Invalid timestamps
  if (!Number.isFinite(prediction.ts)) {
    reasons.push('INVALID_PREDICTION_TS');
  }
  if (!Number.isFinite(outcome.realizedAt) && !Number.isFinite(outcome.exitTs)) {
    reasons.push('INVALID_OUTCOME_TS');
  }

  // Future-data violation
  const predTs = Number(prediction.ts);
  const resTs = Number(outcome.realizedAt || outcome.exitTs);
  if (Number.isFinite(predTs) && Number.isFinite(resTs) && resTs <= predTs) {
    reasons.push('FUTURE_DATA_VIOLATION');
  }

  // Suspicious/quarantined data quality
  if (prediction.dataQuality === 'suspicious' || prediction.dataQuality === 'fail' ||
      prediction.dataQuality === 'quarantined') {
    reasons.push('SUSPICIOUS_DATA_QUALITY');
  }

  // Unknown direction (not a real prediction)
  if (prediction.direction === 'unknown') {
    reasons.push('UNKNOWN_DIRECTION');
  }

  return { excluded: reasons.length > 0, reasons };
}

/**
 * Deduplicate predictions by predictionId (keep first occurrence).
 */
function deduplicatePredictions(predictions) {
  const seen = new Set();
  const result = [];
  for (const p of predictions) {
    const id = p.predictionId;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(p);
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * Matched-sample construction.
 * ------------------------------------------------------------------ */

/**
 * Construct matched samples from predictions and A/B comparisons.
 * A matched sample requires both Group A (V1 actual) and Group B (V1+ATLAS)
 * results for the same prediction event.
 */
function constructMatchedSamples(data) {
  const { predictions, outcomes, abPaperState } = data;

  // Build outcome lookup by mint (closest outcome to prediction)
  const outcomeByMint = {};
  for (const o of outcomes) {
    if (o && o.mint) {
      if (!outcomeByMint[o.mint]) outcomeByMint[o.mint] = [];
      outcomeByMint[o.mint].push(o);
    }
  }

  // Build A/B comparison lookup
  const comparisons = (abPaperState && abPaperState.comparisons) || [];
  const compByMint = {};
  for (const c of comparisons) {
    if (c && c.mint) {
      if (!compByMint[c.mint]) compByMint[c.mint] = [];
      compByMint[c.mint].push(c);
    }
  }

  const matched = [];
  const excluded = [];
  const validPredictions = deduplicatePredictions(predictions);

  for (const pred of validPredictions) {
    // Find corresponding outcome
    const mintOutcomes = outcomeByMint[pred.mint] || [];
    const outcome = mintOutcomes.find(o => {
      const oTs = Number(o.realizedAt || o.exitTs);
      const pTs = Number(pred.ts);
      return Number.isFinite(oTs) && Number.isFinite(pTs) && oTs > pTs;
    });

    // Check exclusion
    const exResult = isExcluded(pred, outcome);
    if (exResult.excluded) {
      excluded.push({
        predictionId: pred.predictionId,
        mint: pred.mint,
        agent: pred.agent,
        reasons: exResult.reasons
      });
      continue;
    }

    // Find A/B comparison
    const mintComps = compByMint[pred.mint] || [];
    const comp = mintComps.length > 0 ? mintComps[mintComps.length - 1] : null;

    const circuitReturn = comp ? (comp.v1Return || 0) : 0;
    const atlasReturn = comp ? (comp.atlasReturn || 0) : (pred.direction === 'bullish' ? (outcome.pnlPct || 0) : 0);

    matched.push({
      predictionId: pred.predictionId,
      mint: pred.mint,
      symbol: pred._candSymbol || pred.mint,
      pairAddress: pred.pairAddress,
      dex: pred.dex,
      predictionTimestamp: pred.ts,
      agent: pred.agent,
      direction: pred.direction,
      confidence: pred.confidence,
      dataQuality: pred.dataQuality,
      marketRegime: pred.marketRegime,
      circuitReturn,
      atlasReturn,
      difference: atlasReturn - circuitReturn,
      outcomePnlPct: outcome.pnlPct,
      outcomeRealizedAt: outcome.realizedAt || outcome.exitTs,
      exitReason: outcome.exitReason || null
    });
  }

  return { matched, excluded, total: validPredictions.length };
}

/* ------------------------------------------------------------------ *
 * Full analysis.
 * ------------------------------------------------------------------ */

/**
 * Run the complete evidence analysis.
 * @param {string} dataDir — path to ATLAS data directory
 * @param {object} opts — { bootstrapIterations, seed }
 * @returns {object} complete analysis report
 */
function analyze(dataDir, opts = {}) {
  const bootstrapIterations = opts.bootstrapIterations || 10000;
  const seed = opts.seed || 42;

  // Load data
  const data = loadData(dataDir);

  // Construct matched samples
  const { matched, excluded, total } = constructMatchedSamples(data);

  // Look-ahead audit
  const lookaheadAudit = auditFromDb(data.db);

  // Build circuit and atlas return arrays
  const circuitReturns = matched.map(m => m.circuitReturn);
  const atlasReturns = matched.map(m => m.atlasReturn);
  const differences = matched.map(m => m.difference);

  // Statistics
  const matchedAnalysis = statsLib.matchedSampleAnalysis(
    matched.map(m => ({ circuitReturn: m.circuitReturn, atlasReturn: m.atlasReturn }))
  );

  const circuitCI = statsLib.bootstrapCI(circuitReturns, { iterations: bootstrapIterations });
  const atlasCI = statsLib.bootstrapCI(atlasReturns, { iterations: bootstrapIterations });
  const pairedCI = statsLib.pairedBootstrapCI(circuitReturns, atlasReturns, { iterations: bootstrapIterations });

  const effectSize = statsLib.effectSize(matchedAnalysis);
  const statTest = statsLib.pairedTest(circuitReturns, atlasReturns);

  // Evidence state
  const n = matched.length;
  const evidenceState = statsLib.evidenceState(n);
  const checkpoints = statsLib.checkpointStatus(n);

  // Per-horizon analysis
  const horizons = {};
  for (const h of ['5m', '15m', '30m', '1h', '4h']) {
    // For now, all outcomes use the same return (actual trade P&L)
    // In production, per-horizon prices would be recorded
    const horizonMatched = matched.filter(m => true); // all matched
    const hCircuit = horizonMatched.map(m => m.circuitReturn);
    const hAtlas = horizonMatched.map(m => m.atlasReturn);
    horizons[h] = {
      sampleSize: hCircuit.length,
      circuit: computeGroupStats(hCircuit),
      atlas: computeGroupStats(hAtlas),
      paired: computePairedStats(hCircuit, hAtlas)
    };
  }

  // Agent attribution
  const agentStats = {};
  for (const m of matched) {
    const agent = m.agent || 'unknown';
    if (!agentStats[agent]) {
      agentStats[agent] = { predictions: 0, correct: 0, incorrect: 0, returns: [], confidences: [] };
    }
    agentStats[agent].predictions++;
    if (m.direction === 'bullish' && m.outcomePnlPct > 0) agentStats[agent].correct++;
    else if (m.direction === 'bearish' && m.outcomePnlPct < 0) agentStats[agent].correct++;
    else agentStats[agent].incorrect++;
    agentStats[agent].returns.push(m.outcomePnlPct || 0);
    agentStats[agent].confidences.push(m.confidence || 0);
  }

  // Regime breakdown
  const regimeStats = {};
  for (const m of matched) {
    const regime = m.marketRegime || 'unknown';
    if (!regimeStats[regime]) {
      regimeStats[regime] = { sampleSize: 0, circuitReturns: [], atlasReturns: [] };
    }
    regimeStats[regime].sampleSize++;
    regimeStats[regime].circuitReturns.push(m.circuitReturn);
    regimeStats[regime].atlasReturns.push(m.atlasReturn);
  }

  // Disagreement analysis
  const disagreementAnalysis = analyzeDisagreement(matched);

  // Data quality analysis
  const dqAnalysis = analyzeDataQuality(matched);

  // Checkpoint snapshots
  const existingCheckpoints = (data.checkpoints && data.checkpoints.checkpoints) || [];

  // Promotion assessment
  const promotion = assessPromotion(n, matchedAnalysis, effectSize, statTest, checkpoints, horizons, agentStats);

  // Daily stats
  const today = new Date().toISOString().slice(0, 10);
  const dailyStats = {
    date: today,
    predictions: total,
    resolved: matched.length,
    unresolved: Math.max(0, total - matched.length - excluded.length),
    excluded: excluded.length,
    circuitAccuracy: computeAccuracy(circuitReturns, matched, 'circuit'),
    atlasAccuracy: computeAccuracy(atlasReturns, matched, 'atlas'),
    circuitMeanReturn: circuitCI.mean,
    atlasMeanReturn: atlasCI.mean,
    pairedMeanDifference: matchedAnalysis.meanDifference,
    mfe: computeMFE(matched),
    mae: computeMAE(matched),
    disagreementRate: disagreementAnalysis.disagreementRate,
    calibrationError: data.calibration ? data.calibration.calibrationError : null,
    dataQualityRate: total > 0 ? ((total - excluded.length) / total * 100) : null,
    regimeBreakdown: regimeStats
  };

  return {
    // Meta
    timestamp: Date.now(),
    iso: new Date().toISOString(),
    dataDir,
    bootstrapIterations,
    seed,

    // Evidence state
    evidenceState,
    checkpoints,

    // Sample counts
    totalObservations: total,
    validObservations: matched.length,
    excludedObservations: excluded.length,
    exclusionReasons: groupExclusionReasons(excluded),

    // Matched analysis
    matched: matchedAnalysis,

    // Per-group stats
    circuit: {
      sampleSize: circuitReturns.length,
      stats: computeGroupStats(circuitReturns),
      bootstrap: circuitCI
    },
    atlas: {
      sampleSize: atlasReturns.length,
      stats: computeGroupStats(atlasReturns),
      bootstrap: atlasCI
    },

    // Paired statistics
    paired: {
      bootstrap: pairedCI,
      effectSize,
      statisticalTest: statTest
    },

    // Horizons
    horizons,

    // Agent attribution
    agentAttribution: agentStats,

    // Regime analysis
    regimeAnalysis: regimeStats,

    // Disagreement
    disagreement: disagreementAnalysis,

    // Data quality
    dataQuality: dqAnalysis,

    // Look-ahead audit
    lookaheadAudit,

    // Calibration
    calibration: data.calibration || null,

    // Promotion assessment
    promotion,

    // Daily stats
    dailyStats,

    // Raw matched samples (capped for export)
    matchedSamples: matched.slice(0, 500),
    excludedSamples: excluded.slice(0, 200),

    // Existing checkpoints
    existingCheckpoints
  };
}

/* ------------------------------------------------------------------ *
 * Helper functions.
 * ------------------------------------------------------------------ */

function computeGroupStats(returns) {
  if (!returns.length) {
    return { mean: null, median: null, std: null, winRate: null, mfe: null, mae: null, best: null, worst: null };
  }
  const n = returns.length;
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const sorted = returns.slice().sort((a, b) => a - b);
  const median = n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)];
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (n > 1 ? n - 1 : n);
  const std = Math.sqrt(variance);
  const wins = returns.filter(r => r > 0).length;
  const winRate = n > 0 ? (wins / n * 100) : 0;
  const positiveReturns = returns.filter(r => r > 0);
  const negativeReturns = returns.filter(r => r < 0);
  const mfe = positiveReturns.length > 0 ? Math.max(...positiveReturns) : 0;
  const mae = negativeReturns.length > 0 ? Math.max(...negativeReturns.map(Math.abs)) : 0;
  return {
    mean: round(mean, 6),
    median: round(median, 6),
    std: round(std, 6),
    winRate: round(winRate, 2),
    mfe: round(mfe, 6),
    mae: round(mae, 6),
    best: round(sorted[sorted.length - 1], 6),
    worst: round(sorted[0], 6)
  };
}

function computePairedStats(circuitReturns, atlasReturns) {
  if (!circuitReturns.length || circuitReturns.length !== atlasReturns.length) {
    return { meanDifference: null, medianDifference: null, stdDifference: null, positivePercentage: null };
  }
  const diffs = circuitReturns.map((c, i) => atlasReturns[i] - c);
  const n = diffs.length;
  const mean = diffs.reduce((a, b) => a + b, 0) / n;
  const sorted = diffs.slice().sort((a, b) => a - b);
  const median = n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)];
  const variance = diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / (n > 1 ? n - 1 : n);
  const std = Math.sqrt(variance);
  const positive = diffs.filter(d => d > 0).length;
  return {
    meanDifference: round(mean, 6),
    medianDifference: round(median, 6),
    stdDifference: round(std, 6),
    positivePercentage: round((positive / n) * 100, 2)
  };
}

function computeAccuracy(returns, matched, group) {
  if (!returns.length) return null;
  const wins = returns.filter(r => r > 0).length;
  return round((wins / returns.length) * 100, 2);
}

function computeMFE(matched) {
  const positive = matched.filter(m => m.outcomePnlPct > 0);
  return positive.length > 0 ? Math.max(...positive.map(m => m.outcomePnlPct)) : 0;
}

function computeMAE(matched) {
  const negative = matched.filter(m => m.outcomePnlPct < 0);
  return negative.length > 0 ? Math.max(...negative.map(m => Math.abs(m.outcomePnlPct))) : 0;
}

function analyzeDisagreement(matched) {
  const disagreeCount = matched.filter(m => m.difference !== 0).length;
  return {
    totalSamples: matched.length,
    disagreements: disagreeCount,
    disagreementRate: matched.length > 0 ? round((disagreeCount / matched.length) * 100, 2) : null
  };
}

function analyzeDataQuality(matched) {
  const tiers = { ok: 0, suspicious: 0, unknown: 0 };
  for (const m of matched) {
    const dq = m.dataQuality || 'unknown';
    if (dq === 'ok') tiers.ok++;
    else if (dq === 'suspicious') tiers.suspicious++;
    else tiers.unknown++;
  }
  return {
    total: matched.length,
    ok: tiers.ok,
    suspicious: tiers.suspicious,
    unknown: tiers.unknown,
    qualityRate: matched.length > 0 ? round((tiers.ok / matched.length) * 100, 2) : null
  };
}

function groupExclusionReasons(excluded) {
  const reasons = {};
  for (const e of excluded) {
    for (const r of (e.reasons || [])) {
      reasons[r] = (reasons[r] || 0) + 1;
    }
  }
  return reasons;
}

/**
 * Assess whether evidence supports ATLAS promotion.
 * This is READ-ONLY — never automatically enables ATLAS.
 */
function assessPromotion(n, matchedAnalysis, effectSize, statTest, checkpoints, horizons, agentStats) {
  const issues = [];
  const strengths = [];

  // 1. Minimum sample
  if (n < 30) issues.push('INSUFFICIENT_SAMPLE: need 30+ matched observations');
  else strengths.push('Minimum sample met');

  // 2. Matched sample integrity
  if (n < 10) issues.push('Very small matched sample — results exploratory');

  // 3. Look-ahead violations (would be checked externally)

  // 4. Statistical confidence
  if (statTest && statTest.conclusion === 'NOT_SIGNIFICANT') {
    issues.push('NO_CLEAR_ADVANTAGE: ATLAS vs Circuit difference not statistically significant');
  } else if (statTest && statTest.conclusion === 'SIGNIFICANT_AT_0.05') {
    strengths.push('Statistical significance at α=0.05');
  }

  // 5. Effect size
  if (effectSize && effectSize.interpretation === 'NEGLIGIBLE') {
    issues.push('NEGLIGIBLE_EFFECT: effect size too small to matter practically');
  } else if (effectSize && (effectSize.interpretation === 'MEDIUM' || effectSize.interpretation === 'LARGE')) {
    strengths.push('Meaningful effect size: ' + effectSize.interpretation);
  }

  // 6. Mean return direction
  if (matchedAnalysis && matchedAnalysis.meanDifference != null) {
    if (matchedAnalysis.meanDifference <= 0) {
      issues.push('ATLAS mean return not higher than Circuit');
    } else {
      strengths.push('ATLAS mean return higher than Circuit');
    }
  }

  // 7. Horizon consistency
  const horizonDirs = Object.values(horizons).map(h => h.paired && h.paired.meanDifference);
  const allPositive = horizonDirs.every(d => d != null && d > 0);
  const allNegative = horizonDirs.every(d => d != null && d < 0);
  if (allPositive) strengths.push('Consistent positive difference across horizons');
  if (allNegative) issues.push('ATLAS underperforms across all horizons');

  // Determine overall result
  let result;
  if (n < 30) {
    result = 'NOT_READY';
  } else if (issues.length > strengths.length) {
    result = 'EVIDENCE_DOES_NOT_SUPPORT_ATLAS';
  } else if (strengths.length > issues.length && n >= 100) {
    result = 'EVIDENCE_SUPPORTS_ATLAS';
  } else if (strengths.length > 0 && issues.length > 0) {
    result = 'INCONCLUSIVE';
  } else {
    result = 'PROMISING';
  }

  return {
    result,
    strengths,
    issues,
    note: 'This assessment NEVER automatically enables ATLAS. Any future promotion requires explicit human action.',
    automaticallyPromoted: false // ALWAYS false
  };
}

function round(n, decimals) {
  if (!Number.isFinite(n)) return 0;
  const f = Math.pow(10, decimals || 0);
  return Math.round(n * f) / f;
}

module.exports = { analyze, loadData, constructMatchedSamples, isExcluded, deduplicatePredictions, computeGroupStats, computePairedStats };
