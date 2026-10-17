#!/usr/bin/env node
/**
 * tradingagents-counterfactual.js — TradingAgents Validation, Attribution
 * & Counterfactual Journal.
 *
 * PURPOSE: Measurement-only. Answers: "Does TradingAgents actually add
 * predictive value?" This module does NOT change any trading decision.
 *
 * Architecture:
 *   CIRCUIT V1 DECISION (authoritative) + TRADINGAGENTS RESEARCH (advisory)
 *       ↓
 *   COUNTERFACTUAL JOURNAL (this module)
 *       ↓
 *   OUTCOME TRACKING (resolves after real time passes)
 *       ↓
 *   AGENT SCORING / CALIBRATION / ATTRIBUTION / REGIME METRICS
 *
 * All persistence is append-only JSONL for history + separate aggregate JSON.
 * No wallet / keys / signing / broadcast. Paper-only. Real market data.
 */

'use strict';

const fs = require('fs');
const path = require('path');

/* ------------------------------------------------------------------ *
 * Persistence files (inside the agent data dir).
 * ------------------------------------------------------------------ */

const COUNTERFACTUAL_FILE = 'tradingagents-counterfactual.jsonl';
const AGENT_METRICS_FILE  = 'tradingagents-agent-metrics.json';
const REGIME_METRICS_FILE = 'tradingagents-regime-metrics.json';
const CALIBRATION_FILE    = 'tradingagents-calibration.json';
const ATTRIBUTION_FILE    = 'tradingagents-attribution.jsonl';

/* ------------------------------------------------------------------ *
 * Constants.
 * ------------------------------------------------------------------ */

const AGENT_NAMES = ['technical', 'quant', 'sentiment', 'market', 'bull', 'bear', 'risk'];
const REGIMES = ['normal', 'consolidation', 'recovery', 'dump'];
const RESOLUTION_HORIZONS = [
  { key: '5m',  ms: 5 * 60 * 1000 },
  { key: '15m', ms: 15 * 60 * 1000 },
  { key: '30m', ms: 30 * 60 * 1000 },
  { key: '1h',  ms: 60 * 60 * 1000 },
  { key: '4h',  ms: 4 * 60 * 60 * 1000 }
];

const CONFIDENCE_BUCKETS = [
  { label: '50-59%', lo: 50, hi: 59 },
  { label: '60-69%', lo: 60, hi: 69 },
  { label: '70-79%', lo: 70, hi: 79 },
  { label: '80-89%', lo: 80, hi: 89 },
  { label: '90-100%', lo: 90, hi: 100 }
];

/* Sample-size evidence labels. */
const EVIDENCE_LABELS = [
  { min: 200, label: 'STRONGER EVIDENCE' },
  { min: 100, label: 'DEVELOPING EVIDENCE' },
  { min: 30,  label: 'EARLY SIGNAL' },
  { min: 0,   label: 'INSUFFICIENT SAMPLE' }
];

/* Darwinian reputation thresholds (configurable). */
const DEFAULT_REPUTATION_THRESHOLDS = {
  provisionalMin: 10,
  eligibleMin: 25,
  strongConfidenceMin: 50,
  highConfidenceMin: 100
};

/* Value-add composite weights (configurable). */
const DEFAULT_VALUE_ADD_WEIGHTS = {
  directionalAccuracy: 0.25,
  averageReturn: 0.25,
  adverseExcursion: 0.15,
  calibration: 0.15,
  riskWarningAccuracy: 0.10,
  agreementUsefulness: 0.10
};

/* ------------------------------------------------------------------ *
 * Helpers.
 * ------------------------------------------------------------------ */

function round(n, digits = 6) {
  if (!Number.isFinite(n)) return 0;
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

function nowIso(ts) {
  return new Date(ts).toISOString();
}

function atomicWriteJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));
}

function safeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function safeJsonParse(str) {
  try { return JSON.parse(str); } catch (_) { return null; }
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch (_) { return null; }
    }).filter(Boolean);
  } catch (_) { return []; }
}

function appendJsonl(file, obj) {
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

/* ------------------------------------------------------------------ *
 * Blank / default state constructors.
 * ------------------------------------------------------------------ */

function blankAgentMetrics(name) {
  return {
    name,
    totalPredictions: 0,
    directionalPredictions: 0,
    correct: 0,
    incorrect: 0,
    accuracy: null,
    averageReturn: null,
    averageMFE: null,
    averageMAE: null,
    sumReturns: 0,
    sumMFE: 0,
    sumMAE: 0,
    reputation: 1.0,
    confidenceCalibration: {},
    usefulnessScore: null,
    regimeBreakdown: {}
  };
}

function blankRegimeMetrics() {
  const m = {};
  for (const r of REGIMES) {
    m[r] = { total: 0, correct: 0, incorrect: 0, accuracy: null, averageReturn: null, sumReturn: 0 };
  }
  return m;
}

function blankCalibration() {
  const m = {};
  for (const b of CONFIDENCE_BUCKETS) {
    m[b.label] = { predictionCount: 0, correct: 0, accuracy: null, averageReturn: null, sumReturn: 0 };
  }
  return m;
}

function blankValueAddWeights() {
  return Object.assign({}, DEFAULT_VALUE_ADD_WEIGHTS);
}

/* ------------------------------------------------------------------ *
 * createCounterfactualJournal
 *
 * options:
 *   dataDir                  — agent data dir (required)
 *   log(msg)                 — logger (default no-op)
 *   reputationThresholds     — configurable sample thresholds
 *   valueAddWeights          — configurable composite weights
 * ------------------------------------------------------------------ */

function createCounterfactualJournal(options = {}) {
  const dataDir = options.dataDir || process.cwd();
  const log = typeof options.log === 'function' ? options.log : () => {};
  const repThresholds = Object.assign({}, DEFAULT_REPUTATION_THRESHOLDS, options.reputationThresholds || {});
  const vaWeights = Object.assign({}, blankValueAddWeights(), options.valueAddWeights || {});

  const counterfactualFile = path.join(dataDir, COUNTERFACTUAL_FILE);
  const agentMetricsFile   = path.join(dataDir, AGENT_METRICS_FILE);
  const regimeMetricsFile  = path.join(dataDir, REGIME_METRICS_FILE);
  const calibrationFile    = path.join(dataDir, CALIBRATION_FILE);
  const attributionFile    = path.join(dataDir, ATTRIBUTION_FILE);

  /* ---- Load persisted aggregate state ----------------------------------- */

  function loadJsonSafe(file, fallback) {
    try {
      if (!fs.existsSync(file)) return fallback;
      const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
      return obj && typeof obj === 'object' ? obj : fallback;
    } catch (_) { return fallback; }
  }

  let agentMetrics = loadJsonSafe(agentMetricsFile, null);
  if (!agentMetrics || !agentMetrics.agents) {
    agentMetrics = { version: 1, updatedAt: null, agents: {} };
    for (const name of AGENT_NAMES) {
      agentMetrics.agents[name] = blankAgentMetrics(name);
    }
  }

  let regimeMetrics = loadJsonSafe(regimeMetricsFile, null);
  if (!regimeMetrics || !regimeMetrics.regimes) {
    regimeMetrics = { version: 1, updatedAt: null, regimes: blankRegimeMetrics() };
  }

  let calibration = loadJsonSafe(calibrationFile, null);
  if (!calibration || !calibration.buckets) {
    calibration = { version: 1, updatedAt: null, buckets: blankCalibration() };
  }

  /* State counters (in-memory; aggregate files are source of truth). */
  let totalPredictions = 0;
  let resolvedPredictions = 0;
  let unresolvedPredictions = 0;
  let dirty = false;

  /* ---- Persist helpers ------------------------------------------------- */

  function persistAgentMetrics() {
    agentMetrics.updatedAt = Date.now();
    try { atomicWriteJson(agentMetricsFile, agentMetrics); } catch (_) {}
  }

  function persistRegimeMetrics() {
    regimeMetrics.updatedAt = Date.now();
    try { atomicWriteJson(regimeMetricsFile, regimeMetrics); } catch (_) {}
  }

  function persistCalibration() {
    calibration.updatedAt = Date.now();
    try { atomicWriteJson(calibrationFile, calibration); } catch (_) {}
  }

  function persistAll() {
    if (!dirty) return;
    dirty = false;
    persistAgentMetrics();
    persistRegimeMetrics();
    persistCalibration();
  }

  /* ================================================================= *
   * 4. COUNTERFACTUAL DECISION JOURNAL
   * ================================================================= *
   * Record a snapshot every time TradingAgents evaluates a candidate
   * that passes the Circuit V1 BUY filter.
   */

  /**
   * Record a counterfactual prediction snapshot.
   * @param {object} snapshot — the full snapshot described in §4
   * @returns {object} the persisted record (with id)
   */
  function recordPrediction(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return null;
    if (!snapshot.mint || !snapshot.timestamp) return null;

    /* Look-ahead protection: reject if any outcome data is embedded. */
    if (snapshot.outcome && typeof snapshot.outcome === 'object' &&
        snapshot.outcome.resolvedAt) {
      log('WARN: recordPrediction rejected — outcome data embedded (look-ahead bias)');
      return null;
    }

    const record = {
      id: 'cf-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      timestamp: snapshot.timestamp,
      timestampIso: nowIso(snapshot.timestamp),
      mint: snapshot.mint,
      symbol: snapshot.symbol || null,

      marketObservation: Object.assign({
        price: null,
        priceSol: null,
        pairAddress: null,
        dex: null,
        priceAgeMs: null,
        integrityStatus: null
      }, snapshot.marketObservation || {}),

      circuitDecision: Object.assign({
        decision: 'FILTER',
        score: null,
        minScore: null,
        recovery5m: null,
        change1h: null
      }, snapshot.circuitDecision || {}),

      tradingAgents: Object.assign({
        mode: 'SHADOW',
        recommendation: 'HOLD',
        confidence: null,
        researchScore: null,
        riskLevel: 'medium',
        consensus: 'mixed',
        disagreement: null
      }, snapshot.tradingAgents || {}),

      agents: snapshot.agents || {},

      counterfactual: Object.assign({
        hypotheticalEntryPrice: null,
        hypotheticalEntryTime: null,
        hypotheticalSize: null,
        hypotheticalDecision: null
      }, snapshot.counterfactual || {}),

      outcome: null
    };

    /* Extract per-agent directional predictions for later scoring. */
    for (const name of AGENT_NAMES) {
      const agent = record.agents[name];
      if (agent && typeof agent === 'object') {
        agent._directional = extractDirection(name, agent);
      }
    }

    /* Compute disagreement score. */
    record.tradingAgents.disagreement = computeDisagreement(record.agents);

    try {
      appendJsonl(counterfactualFile, record);
      totalPredictions += 1;
      unresolvedPredictions += 1;
      return record;
    } catch (err) {
      log('ERROR: recordPrediction append failed: ' + err.message);
      return null;
    }
  }

  /* ================================================================= *
   * 5. COUNTERFACTUAL OUTCOME TRACKING
   * ================================================================= *
   * Resolve predictions when enough future data is available.
   */

  /**
   * Get all unresolved predictions.
   */
  function getUnresolved() {
    const all = readJsonl(counterfactualFile);
    return all.filter((r) => !r.outcome || r.outcome === null);
  }

  /**
   * Attempt to resolve a single prediction with price data at various horizons.
   * @param {string} id — prediction id
   * @param {object} prices — { '5m': priceSol, '15m': priceSol, ... }
   * @param {number} now — current timestamp
   * @returns {object|null} the resolved record, or null if not resolvable yet
   */
  function resolveOutcome(id, prices, now) {
    if (!id || !prices || typeof prices !== 'object') return null;
    now = now || Date.now();

    const all = readJsonl(counterfactualFile);
    const idx = all.findIndex((r) => r && r.id === id);
    if (idx < 0) return null;
    const record = all[idx];
    if (record.outcome && record.outcome !== null) return record; // already resolved

    const predTs = record.timestamp;
    if (!predTs || predTs >= now) return null; // prediction in the future (invalid)

    const entryPrice = record.counterfactual &&
      Number.isFinite(record.counterfactual.hypotheticalEntryPrice)
      ? record.counterfactual.hypotheticalEntryPrice
      : (record.marketObservation && Number.isFinite(record.marketObservation.priceSol)
        ? record.marketObservation.priceSol : null);

    if (!entryPrice || entryPrice <= 0) return null;

    const outcome = {
      resolvedAt: now,
      resolvedAtIso: nowIso(now)
    };

    let anyResolved = false;
    for (const h of RESOLUTION_HORIZONS) {
      const horizonMs = h.ms;
      const requiredTs = predTs + horizonMs;
      if (now >= requiredTs && Number.isFinite(prices[h.key]) && prices[h.key] > 0) {
        const ret = ((prices[h.key] / entryPrice) - 1) * 100;
        outcome['priceAfter' + h.key] = prices[h.key];
        outcome['return' + h.key] = round(ret, 4);
        anyResolved = true;
      } else {
        outcome['priceAfter' + h.key] = null;
        outcome['return' + h.key] = null;
      }
    }

    /* MFE / MAE from whatever horizon prices are available. */
    let maxFavorable = -Infinity;
    let maxAdverse = Infinity;
    for (const h of RESOLUTION_HORIZONS) {
      const p = outcome['priceAfter' + h.key];
      if (Number.isFinite(p) && p > 0) {
        const ret = ((p / entryPrice) - 1) * 100;
        if (ret > maxFavorable) maxFavorable = ret;
        if (ret < maxAdverse) maxAdverse = ret;
      }
    }

    outcome.maximumFavorableExcursion = maxFavorable > -Infinity ? round(maxFavorable, 4) : null;
    outcome.maximumAdverseExcursion = maxAdverse < Infinity ? round(maxAdverse, 4) : null;

    /* Determine hypothetical outcome. */
    const primaryReturn = outcome.return30m != null ? outcome.return30m
      : (outcome.return1h != null ? outcome.return1h
        : (outcome.return15m != null ? outcome.return15m
          : (outcome.return5m != null ? outcome.return5m : null)));

    if (primaryReturn != null) {
      if (primaryReturn > 0.5) outcome.hypotheticalOutcome = 'WIN';
      else if (primaryReturn < -0.5) outcome.hypotheticalOutcome = 'LOSS';
      else outcome.hypotheticalOutcome = 'NEUTRAL';
    } else {
      outcome.hypotheticalOutcome = 'UNRESOLVED';
    }

    record.outcome = outcome;

    /* Rewrite the JSONL file with the updated record. */
    try {
      all[idx] = record;
      const tmp = counterfactualFile + '.tmp';
      const lines = all.map((r) => JSON.stringify(r)).join('\n') + '\n';
      fs.writeFileSync(tmp, lines);
      fs.renameSync(tmp, counterfactualFile);
      if (anyResolved) {
        resolvedPredictions += 1;
        unresolvedPredictions = Math.max(0, unresolvedPredictions - 1);
      }
      return record;
    } catch (err) {
      log('ERROR: resolveOutcome rewrite failed: ' + err.message);
      return null;
    }
  }

  /**
   * Batch-resolve all eligible predictions given current time and
   * a price-fetcher function: fetchPrice(mint, targetTs) → priceSol or null.
   */
  function resolveAll(fetchPriceFn, now) {
    now = now || Date.now();
    const unresolved = getUnresolved();
    let resolved = 0;
    for (const rec of unresolved) {
      if (!rec.mint || !rec.timestamp) continue;
      const prices = {};
      for (const h of RESOLUTION_HORIZONS) {
        const targetTs = rec.timestamp + h.ms;
        if (now >= targetTs) {
          try {
            const p = fetchPriceFn(rec.mint, targetTs);
            if (Number.isFinite(p) && p > 0) prices[h.key] = p;
          } catch (_) {}
        }
      }
      if (Object.keys(prices).length > 0) {
        const result = resolveOutcome(rec.id, prices, now);
        if (result && result.outcome && result.outcome.hypotheticalOutcome !== 'UNRESOLVED') {
          resolved += 1;
        }
      }
    }
    if (resolved > 0) {
      updateAgentMetricsFromResolved();
      persistAll();
    }
    return resolved;
  }

  /* ================================================================= *
   * AGENT-BY-AGENT SCORING (§7)
   * ================================================================= */

  function extractDirection(agentName, agent) {
    if (!agent || typeof agent !== 'object') return null;
    switch (agentName) {
      case 'technical':
        if (agent.direction === 'bullish') return 'bullish';
        if (agent.direction === 'bearish') return 'bearish';
        return null; // neutral/unknown = no directional prediction
      case 'quant':
        if (agent.expectedDirection === 'up') return 'bullish';
        if (agent.expectedDirection === 'down') return 'bearish';
        return null;
      case 'sentiment':
        if (agent.direction === 'bullish') return 'bullish';
        if (agent.direction === 'bearish') return 'bearish';
        return null;
      case 'market':
        if (agent.regime === 'bull') return 'bullish';
        if (agent.regime === 'dump' || agent.regime === 'recovery') return 'bearish';
        return null;
      case 'bull':
        if (Number.isFinite(agent.confidence) && agent.confidence >= 55) return 'bullish';
        return null;
      case 'bear':
        if (Number.isFinite(agent.riskScore) && agent.riskScore >= 55) return 'bearish';
        return null;
      case 'risk':
        if (agent.riskLevel === 'critical' || agent.riskLevel === 'high') return 'bearish';
        if (agent.riskLevel === 'low') return 'bullish';
        return null;
      default:
        return null;
    }
  }

  /**
   * After resolving outcomes, update per-agent metrics from resolved records.
   */
  function updateAgentMetricsFromResolved() {
    const all = readJsonl(counterfactualFile);
    const resolved = all.filter((r) => r.outcome && r.outcome.hypotheticalOutcome !== 'UNRESOLVED');

    /* Reset metrics and recompute from scratch (deterministic). */
    for (const name of AGENT_NAMES) {
      agentMetrics.agents[name] = blankAgentMetrics(name);
    }
    const regime = blankRegimeMetrics();
    const cal = blankCalibration();

    for (const rec of resolved) {
      const outcome = rec.outcome;
      const won = outcome.hypotheticalOutcome === 'WIN';
      const returnPct = outcome.return30m != null ? outcome.return30m
        : (outcome.return1h != null ? outcome.return1h
          : (outcome.return15m != null ? outcome.return15m
            : (outcome.return5m != null ? outcome.return5m : 0)));
      const mfe = outcome.maximumFavorableExcursion;
      const mae = outcome.maximumAdverseExcursion;

      /* Determine regime from market observation or default to 'normal'. */
      const recRegime = (rec.marketObservation && rec.marketObservation.regime) || 'normal';
      const rKey = REGIMES.includes(recRegime) ? recRegime : 'normal';

      /* Update regime metrics. */
      regime[rKey].total += 1;
      if (won) regime[rKey].correct += 1;
      else regime[rKey].incorrect += 1;
      regime[rKey].sumReturn += returnPct;
      regime[rKey].accuracy = regime[rKey].total > 0
        ? round((regime[rKey].correct / regime[rKey].total) * 100, 2) : null;
      regime[rKey].averageReturn = regime[rKey].total > 0
        ? round(regime[rKey].sumReturn / regime[rKey].total, 4) : null;

      /* Update per-agent metrics. */
      for (const name of AGENT_NAMES) {
        const agentData = rec.agents && rec.agents[name];
        if (!agentData) continue;
        const am = agentMetrics.agents[name];
        const direction = agentData._directional || extractDirection(name, agentData);
        am.totalPredictions += 1;

        /* Regime breakdown. */
        if (!am.regimeBreakdown[rKey]) {
          am.regimeBreakdown[rKey] = { total: 0, correct: 0, incorrect: 0, accuracy: null, averageReturn: null, sumReturn: 0 };
        }
        am.regimeBreakdown[rKey].total += 1;

        if (direction) {
          am.directionalPredictions += 1;
          const correct = (direction === 'bullish') ? won : !won;
          if (correct) am.correct += 1;
          else am.incorrect += 1;
          am.sumReturns += returnPct;
          if (Number.isFinite(mfe)) am.sumMFE += mfe;
          if (Number.isFinite(mae)) am.sumMAE += mae;

          am.regimeBreakdown[rKey].sumReturn += returnPct;
          if (correct) am.regimeBreakdown[rKey].correct += 1;
          else am.regimeBreakdown[rKey].incorrect += 1;
        }

        am.accuracy = am.directionalPredictions > 0
          ? round((am.correct / am.directionalPredictions) * 100, 2) : null;
        am.averageReturn = am.directionalPredictions > 0
          ? round(am.sumReturns / am.directionalPredictions, 4) : null;
        am.averageMFE = am.directionalPredictions > 0
          ? round(am.sumMFE / am.directionalPredictions, 4) : null;
        am.averageMAE = am.directionalPredictions > 0
          ? round(am.sumMAE / am.directionalPredictions, 4) : null;

        for (const rk of REGIMES) {
          const rb = am.regimeBreakdown[rk];
          if (rb && rb.total > 0) {
            rb.accuracy = round((rb.correct / rb.total) * 100, 2);
            rb.averageReturn = round(rb.sumReturn / rb.total, 4);
          }
        }

        /* Reputation. */
        am.reputation = computeReputation(am);
        /* Usefulness. */
        am.usefulnessScore = computeUsefulness(am);
      }

      /* Update confidence calibration. */
      updateCalibration(rec, cal);
    }

    agentMetrics.agentsCopy = undefined; // no circular ref
    agentMetrics = { version: 1, updatedAt: Date.now(), agents: agentMetrics.agents };
    regimeMetrics = { version: 1, updatedAt: Date.now(), regimes: regime };
    calibration = { version: 1, updatedAt: Date.now(), buckets: cal };
    dirty = true;
  }

  /* ================================================================= *
   * 9. DARWINIAN AGENT SCORE (§9)
   * ================================================================= */

  function computeReputation(am) {
    const n = am.directionalPredictions || 0;
    if (n < repThresholds.provisionalMin) return 1.0;

    const acc = am.accuracy != null ? am.accuracy / 100 : 0.5;
    const ret = am.averageReturn != null ? am.averageReturn : 0;

    /* Blend accuracy and return into a reputation score centered on 1.0. */
    let rep = 1.0;
    if (n >= repThresholds.highConfidenceMin) {
      rep = 1.0 + (acc - 0.5) * 1.0 + clamp(ret / 10, -0.3, 0.3);
    } else if (n >= repThresholds.strongConfidenceMin) {
      rep = 1.0 + (acc - 0.5) * 0.7 + clamp(ret / 10, -0.2, 0.2);
    } else if (n >= repThresholds.eligibleMin) {
      rep = 1.0 + (acc - 0.5) * 0.4 + clamp(ret / 10, -0.1, 0.1);
    } else {
      /* provisional: 10-24 samples, gentle adjustment only */
      rep = 1.0 + (acc - 0.5) * 0.2;
    }

    return round(clamp(rep, 0.3, 2.5), 3);
  }

  /* ================================================================= *
   * 10. CONFIDENCE CALIBRATION (§10)
   * ================================================================= */

  function getConfidenceBucket(confidence) {
    const c = safeNumber(confidence);
    for (const b of CONFIDENCE_BUCKETS) {
      if (c >= b.lo && c <= b.hi) return b.label;
    }
    return null;
  }

  function updateCalibration(rec, cal) {
    if (!rec.agents) return;
    /* Use the synthesizer-level confidence as the primary calibration target. */
    const ta = rec.tradingAgents || {};
    const conf = ta.confidence != null ? ta.confidence : ta.researchScore;
    const bucket = getConfidenceBucket(conf);
    if (!bucket || !cal[bucket]) return;

    const outcome = rec.outcome;
    if (!outcome || outcome.hypotheticalOutcome === 'UNRESOLVED') return;

    const won = outcome.hypotheticalOutcome === 'WIN';
    const returnPct = outcome.return30m != null ? outcome.return30m
      : (outcome.return1h != null ? outcome.return1h
        : (outcome.return5m != null ? outcome.return5m : 0));

    cal[bucket].predictionCount += 1;
    if (won) cal[bucket].correct += 1;
    cal[bucket].sumReturn += returnPct;
    cal[bucket].accuracy = cal[bucket].predictionCount > 0
      ? round((cal[bucket].correct / cal[bucket].predictionCount) * 100, 2) : null;
    cal[bucket].averageReturn = cal[bucket].predictionCount > 0
      ? round(cal[bucket].sumReturn / cal[bucket].predictionCount, 4) : null;
  }

  /**
   * Compute calibration error: average absolute difference between
   * confidence midpoint and actual accuracy across all buckets.
   */
  function calibrationError() {
    let totalDiff = 0;
    let count = 0;
    for (const b of CONFIDENCE_BUCKETS) {
      const bucket = calibration.buckets[b.label];
      if (bucket && bucket.predictionCount >= 5 && bucket.accuracy != null) {
        const midpoint = (b.lo + b.hi) / 2;
        totalDiff += Math.abs(midpoint - bucket.accuracy);
        count += 1;
      }
    }
    return count > 0 ? round(totalDiff / count, 2) : null;
  }

  /* ================================================================= *
   * 11. DISAGREEMENT ANALYSIS (§11)
   * ================================================================= */

  function computeDisagreement(agents) {
    if (!agents || typeof agents !== 'object') return null;
    let buyCount = 0, holdCount = 0, sellCount = 0;
    let total = 0;

    for (const name of AGENT_NAMES) {
      const agent = agents[name];
      if (!agent || typeof agent !== 'object') continue;
      total += 1;
      const dir = extractDirection(name, agent);
      if (dir === 'bullish') buyCount += 1;
      else if (dir === 'bearish') sellCount += 1;
      else holdCount += 1;
    }

    if (total === 0) return { consensusPercentage: 0, buyCount: 0, holdCount: 0, sellCount: 0, disagreementScore: 1.0 };

    const maxCount = Math.max(buyCount, holdCount, sellCount);
    const consensusPercentage = round((maxCount / total) * 100, 2);
    const disagreementScore = round(1 - (maxCount / total), 4);

    return {
      consensusPercentage,
      buyCount,
      holdCount,
      sellCount,
      total,
      disagreementScore,
      level: disagreementScore <= 0.25 ? 'LOW' : (disagreementScore <= 0.5 ? 'MEDIUM' : 'HIGH')
    };
  }

  /* ================================================================= *
   * 12. BEAR / RISK EFFECTIVENESS (§12)
   * ================================================================= */

  function bearRiskEffectiveness() {
    const all = readJsonl(counterfactualFile);
    const resolved = all.filter((r) => r.outcome && r.outcome.hypotheticalOutcome !== 'UNRESOLVED');

    let bearWarnings = 0;
    let bearCorrectWarnings = 0;
    let riskWarnings = 0;
    let riskCorrectWarnings = 0;
    let totalLosses = 0;

    for (const rec of resolved) {
      const won = rec.outcome.hypotheticalOutcome === 'WIN';
      if (!won) totalLosses += 1;

      const bear = rec.agents && rec.agents.bear;
      if (bear && bear.riskScore >= 55) {
        bearWarnings += 1;
        if (!won) bearCorrectWarnings += 1;
      }

      const risk = rec.agents && rec.agents.risk;
      if (risk && (risk.riskLevel === 'high' || risk.riskLevel === 'critical')) {
        riskWarnings += 1;
        if (!won) riskCorrectWarnings += 1;
      }
    }

    return {
      bearAccuracy: bearWarnings > 0 ? round((bearCorrectWarnings / bearWarnings) * 100, 2) : null,
      bearWarnings,
      bearCorrectWarnings,
      riskAccuracy: riskWarnings > 0 ? round((riskCorrectWarnings / riskWarnings) * 100, 2) : null,
      riskWarnings,
      riskCorrectWarnings,
      riskWarningPrecision: riskWarnings > 0 ? round((riskCorrectWarnings / riskWarnings) * 100, 2) : null,
      riskWarningRecall: totalLosses > 0 ? round((riskCorrectWarnings / totalLosses) * 100, 2) : null,
      totalLosses
    };
  }

  /* ================================================================= *
   * 6. CIRCUIT VS TRADINGAGENTS COMPARISON (§6)
   * ================================================================= */

  function agreementAnalysis() {
    const all = readJsonl(counterfactualFile);
    const resolved = all.filter((r) => r.outcome && r.outcome.hypotheticalOutcome !== 'UNRESOLVED');

    const groups = {
      AGREE_BUY: { total: 0, correct: 0, sumReturn: 0 },
      AGREE_SELL: { total: 0, correct: 0, sumReturn: 0 },
      DISAGREE_BUY_CIRCUIT: { total: 0, correct: 0, sumReturn: 0 },
      DISAGREE_BUY_TA: { total: 0, correct: 0, sumReturn: 0 },
      TA_HOLD: { total: 0, correct: 0, sumReturn: 0 },
      TA_BEARISH: { total: 0, correct: 0, sumReturn: 0 }
    };

    for (const rec of resolved) {
      const circuit = (rec.circuitDecision && rec.circuitDecision.decision) || 'FILTER';
      const ta = (rec.tradingAgents && rec.tradingAgents.recommendation) || 'HOLD';
      const won = rec.outcome.hypotheticalOutcome === 'WIN';
      const returnPct = rec.outcome.return30m != null ? rec.outcome.return30m
        : (rec.outcome.return1h != null ? rec.outcome.return1h
          : (rec.outcome.return5m != null ? rec.outcome.return5m : 0));

      let group;
      if (circuit === 'BUY' && (ta === 'BUY')) group = 'AGREE_BUY';
      else if (circuit === 'SELL' && ta === 'AVOID') group = 'AGREE_SELL';
      else if (circuit === 'BUY' && ta !== 'BUY') group = 'DISAGREE_BUY_CIRCUIT';
      else if (circuit !== 'BUY' && ta === 'BUY') group = 'DISAGREE_BUY_TA';
      else if (ta === 'HOLD') group = 'TA_HOLD';
      else if (ta === 'AVOID') group = 'TA_BEARISH';
      else group = 'TA_HOLD';

      groups[group].total += 1;
      if (won) groups[group].correct += 1;
      groups[group].sumReturn += returnPct;
    }

    /* Compute accuracy for each group. */
    const result = {};
    for (const [key, g] of Object.entries(groups)) {
      result[key] = {
        total: g.total,
        correct: g.correct,
        accuracy: g.total > 0 ? round((g.correct / g.total) * 100, 2) : null,
        averageReturn: g.total > 0 ? round(g.sumReturn / g.total, 4) : null
      };
    }

    return result;
  }

  /* ================================================================= *
   * 13. TRADE ATTRIBUTION (§13)
   * ================================================================= */

  /**
   * Record trade attribution for a real Circuit trade.
   * @param {object} trade — { tradeId, mint, symbol, circuitScore, tradingAgentsScore,
   *   circuitDecision, tradingAgentsRecommendation, consensus, disagreement, riskLevel,
   *   entryPrice, exitPrice, pnl, pnlPct, outcome, regime, agentPredictions,
   *   agentConfidences, priceIntegrityStatus }
   */
  function recordAttribution(trade) {
    if (!trade || !trade.mint) return null;

    const attribution = classifyAttribution(trade);
    const record = Object.assign({
      id: 'attr-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      timestamp: Date.now(),
      timestampIso: nowIso(Date.now())
    }, trade, { attribution });

    try {
      appendJsonl(attributionFile, record);
      return record;
    } catch (err) {
      log('ERROR: recordAttribution append failed: ' + err.message);
      return null;
    }
  }

  function classifyAttribution(trade) {
    const circuitWin = trade.pnlPct > 0;
    const taRec = (trade.tradingAgentsRecommendation || 'HOLD').toUpperCase();
    const taAgrees = (taRec === 'BUY' && circuitWin) || (taRec === 'AVOID' && !circuitWin);
    const taDisagrees = (taRec === 'AVOID' && circuitWin) || (taRec === 'BUY' && !circuitWin);

    if (taAgrees && circuitWin) return 'TA_CORRECT_HELPED';
    if (taAgrees && !circuitWin) return 'TA_CORRECT_BUT_IRRELEVANT';
    if (taDisagrees && circuitWin) return 'TA_WRONG_BUT_CIRCUIT_SAVED';
    if (taDisagrees && !circuitWin) return 'TA_WRONG_AND_HARMFUL';
    if (taRec !== 'HOLD' && !circuitWin) return 'BOTH_WRONG';
    if (taRec !== 'HOLD' && circuitWin) return 'BOTH_CORRECT';
    return 'CIRCUIT_CORRECT_TA_DISAGREED';
  }

  /* ================================================================= *
   * 14. VALUE-ADD SCORE (§14)
   * ================================================================= */

  function computeValueAdd() {
    const agentAccs = [];
    let totalDirectional = 0;
    let totalCorrect = 0;
    let totalReturn = 0;
    let totalMAE = 0;
    let countReturn = 0;
    let countMAE = 0;
    let bearRiskEff = bearRiskEffectiveness();
    let agree = agreementAnalysis();

    for (const name of AGENT_NAMES) {
      const am = agentMetrics.agents[name];
      if (am && am.directionalPredictions > 0) {
        totalDirectional += am.directionalPredictions;
        totalCorrect += am.correct;
        totalReturn += am.sumReturns;
        if (am.averageMAE != null) { totalMAE += Math.abs(am.averageMAE); countMAE += 1; }
      }
    }

    const directionalAccuracy = totalDirectional > 0 ? (totalCorrect / totalDirectional) * 100 : 50;
    const averageReturn = totalDirectional > 0 ? totalReturn / totalDirectional : 0;
    const avgMAE = countMAE > 0 ? totalMAE / countMAE : 0;
    const calErr = calibrationError();
    const calibrationScore = calErr != null ? Math.max(0, 100 - calErr) : 50;

    /* Risk warning accuracy: precision of bear/risk warnings. */
    const riskWarnAcc = bearRiskEff.riskWarningPrecision != null ? bearRiskEff.riskWarningPrecision : 50;

    /* Agreement usefulness: accuracy when TA agrees with Circuit. */
    const agreeGroup = agree.AGREE_BUY || {};
    const disagreeGroup = agree.DISAGREE_BUY_CIRCUIT || {};
    const agreeAcc = agreeGroup.accuracy != null ? agreeGroup.accuracy : 50;
    const disagreeAcc = disagreeGroup.accuracy != null ? disagreeGroup.accuracy : 50;
    const agreementUsefulness = agreeAcc - disagreeAcc; // positive = TA agreement adds value

    /* Composite. */
    const score = round(
      (directionalAccuracy / 100) * vaWeights.directionalAccuracy * 100 +
      clamp(averageReturn, -10, 10) / 10 * vaWeights.averageReturn * 100 +
      clamp(avgMAE, 0, 20) / 20 * (1 - vaWeights.adverseExcursion) * 100 + // lower MAE = better
      (calibrationScore / 100) * vaWeights.calibration * 100 +
      (riskWarnAcc / 100) * vaWeights.riskWarningAccuracy * 100 +
      clamp(agreementUsefulness + 50, 0, 100) / 100 * vaWeights.agreementUsefulness * 100,
      2
    );

    return {
      valueAdd: score,
      components: {
        directionalAccuracy: round(directionalAccuracy, 2),
        averageReturn: round(averageReturn, 4),
        averageMAE: round(avgMAE, 4),
        calibrationError: calErr,
        calibrationScore: round(calibrationScore, 2),
        riskWarningAccuracy: round(riskWarnAcc, 2),
        agreementUsefulness: round(agreementUsefulness, 2)
      },
      weights: Object.assign({}, vaWeights)
    };
  }

  /* ================================================================= *
   * 15. SAMPLE-SIZE GUARDRAILS (§15)
   * ================================================================= */

  function evidenceStatus() {
    const n = resolvedPredictions;
    for (const e of EVIDENCE_LABELS) {
      if (n >= e.min) return { status: e.label, resolvedCount: n };
    }
    return { status: 'INSUFFICIENT SAMPLE', resolvedCount: n };
  }

  /* ================================================================= *
   * 16. STATISTICAL COMPARISON (§16)
   * ================================================================= */

  function statisticalComparison() {
    const all = readJsonl(counterfactualFile);
    const resolved = all.filter((r) => r.outcome && r.outcome.hypotheticalOutcome !== 'UNRESOLVED');

    const taReturns = [];
    const circuitReturns = []; // Circuit V1 always enters (BUY), so circuit return = actual

    for (const rec of resolved) {
      const returnPct = rec.outcome.return30m != null ? rec.outcome.return30m
        : (rec.outcome.return1h != null ? rec.outcome.return1h
          : (rec.outcome.return5m != null ? rec.outcome.return5m : null));
      if (returnPct == null) continue;

      circuitReturns.push(returnPct);

      /* TA hypothetical: if TA agreed with BUY or was HOLD → include return;
       * if TA said AVOID → 0 return (would have stayed out). */
      const taRec = (rec.tradingAgents && rec.tradingAgents.recommendation) || 'HOLD';
      if (taRec === 'BUY' || taRec === 'HOLD') {
        taReturns.push(returnPct);
      } else {
        taReturns.push(0); // AVOID = no trade = 0% return
      }
    }

    const stats = (arr) => {
      if (!arr.length) return { n: 0, mean: null, median: null, std: null, winRate: null, lossRate: null, maxDrawdown: null };
      const n = arr.length;
      const sorted = arr.slice().sort((a, b) => a - b);
      const sum = arr.reduce((a, b) => a + b, 0);
      const mean = sum / n;
      const median = n % 2 === 0 ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2 : sorted[Math.floor(n / 2)];
      const variance = arr.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
      const std = Math.sqrt(variance);
      const wins = arr.filter((x) => x > 0).length;
      const losses = arr.filter((x) => x < 0).length;
      let maxDd = 0;
      let peak = 0;
      let cum = 0;
      for (const r of arr) {
        cum += r;
        if (cum > peak) peak = cum;
        const dd = peak - cum;
        if (dd > maxDd) maxDd = dd;
      }
      return {
        n,
        mean: round(mean, 4),
        median: round(median, 4),
        std: round(std, 4),
        winRate: round((wins / n) * 100, 2),
        lossRate: round((losses / n) * 100, 100),
        maxDrawdown: round(maxDd, 4)
      };
    };

    return {
      circuitV1: stats(circuitReturns),
      tradingAgents: stats(taReturns),
      sampleSize: resolved.length,
      evidence: evidenceStatus().status
    };
  }

  /* ================================================================= *
   * BOOTSTRAP CONFIDENCE INTERVALS (§16)
   * ================================================================= */

  function bootstrapCI(arr, iterations, ciLevel) {
    iterations = iterations || 1000;
    ciLevel = ciLevel || 0.95;
    if (!arr || arr.length < 3) return null;

    const means = [];
    for (let i = 0; i < iterations; i++) {
      const sample = [];
      for (let j = 0; j < arr.length; j++) {
        sample.push(arr[Math.floor(Math.random() * arr.length)]);
      }
      means.push(sample.reduce((a, b) => a + b, 0) / sample.length);
    }
    means.sort((a, b) => a - b);
    const loIdx = Math.floor((1 - ciLevel) / 2 * iterations);
    const hiIdx = Math.floor((1 + ciLevel) / 2 * iterations) - 1;
    return {
      mean: round(means.reduce((a, b) => a + b, 0) / means.length, 4),
      ciLo: round(means[loIdx], 4),
      ciHi: round(means[Math.min(hiIdx, iterations - 1)], 4),
      level: ciLevel,
      iterations
    };
  }

  /* ================================================================= *
   * 17. LOOK-AHEAD PROTECTION (§17)
   * ================================================================= */

  function validateNoLookAhead(predictionRecord, laterData) {
    if (!predictionRecord || !laterData) return { valid: true };
    const errors = [];

    if (laterData.timestamp && predictionRecord.timestamp &&
        laterData.timestamp <= predictionRecord.timestamp) {
      errors.push('resolutionTimestamp must be > predictionTimestamp');
    }

    /* Check that outcome fields don't exist at prediction time. */
    if (predictionRecord.outcome && typeof predictionRecord.outcome === 'object') {
      const oc = predictionRecord.outcome;
      if (oc.resolvedAt || oc.return5m != null || oc.return1h != null) {
        errors.push('outcome data present at prediction time (look-ahead bias)');
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /* ================================================================= *
   * 18. PRICE-INTEGRITY INTEGRATION (§18)
   * ================================================================= */

  function isDataQualityTrustworthy(integrityStatus) {
    if (!integrityStatus) return true;
    const s = String(integrityStatus).toLowerCase();
    return s === 'ok' || s === 'accepted' || s === 'confirmed';
  }

  /**
   * Record a prediction but flag it if price integrity is suspicious.
   * Suspicious observations are NOT excluded — they are marked with
   * dataQuality = 'suspicious' so they can be filtered from metrics.
   */
  function recordPredictionWithIntegrity(snapshot) {
    const record = recordPrediction(snapshot);
    if (!record) return null;

    const integrityStatus = record.marketObservation && record.marketObservation.integrityStatus;
    if (!isDataQualityTrustworthy(integrityStatus)) {
      record.dataQuality = 'suspicious';
      /* Rewrite the record with the flag. */
      try {
        const all = readJsonl(counterfactualFile);
        const idx = all.findIndex((r) => r.id === record.id);
        if (idx >= 0) {
          all[idx].dataQuality = 'suspicious';
          const tmp = counterfactualFile + '.tmp';
          fs.writeFileSync(tmp, all.map((r) => JSON.stringify(r)).join('\n') + '\n');
          fs.renameSync(tmp, counterfactualFile);
        }
      } catch (_) {}
    }

    return record;
  }

  /* ================================================================= *
   * 19. WARMING STATE (§19)
   * ================================================================= */

  function recordWarmingState(mint, symbol, reason) {
    const record = {
      id: 'warm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      timestamp: Date.now(),
      timestampIso: nowIso(Date.now()),
      mint,
      symbol: symbol || null,
      type: 'warming',
      reason: reason || 'insufficient_history',
      outcome: null
    };

    try {
      appendJsonl(counterfactualFile, record);
      return record;
    } catch (_) { return null; }
  }

  /* ================================================================= *
   * SNAPSHOT / SUMMARY (for dashboard + heartbeat)
   * ================================================================= */

  function snapshot() {
    const all = readJsonl(counterfactualFile);
    const predictions = all.filter((r) => r.type !== 'warming');
    const resolved = all.filter((r) => r.outcome && r.outcome.hypotheticalOutcome !== 'UNRESOLVED');
    const unresolved = all.filter((r) => (!r.outcome || r.outcome === null) && r.type !== 'warming');

    const evidence = evidenceStatus();
    const agree = agreementAnalysis();
    const bearRisk = bearRiskEffectiveness();
    const valueAdd = computeValueAdd();
    const calErr = calibrationError();
    const statComp = statisticalComparison();

    /* TA vs Circuit accuracy. */
    const taCorrect = resolved.filter((r) => {
      const ta = (r.tradingAgents && r.tradingAgents.recommendation) || 'HOLD';
      const won = r.outcome.hypotheticalOutcome === 'WIN';
      return (ta === 'BUY' && won) || (ta === 'AVOID' && !won);
    }).length;
    const circuitCorrect = resolved.filter((r) => {
      const circ = (r.circuitDecision && r.circuitDecision.decision) || 'FILTER';
      const won = r.outcome.hypotheticalOutcome === 'WIN';
      return (circ === 'BUY' && won);
    }).length;

    /* Agent scorecard. */
    const agentScorecard = {};
    for (const name of AGENT_NAMES) {
      const am = agentMetrics.agents[name];
      agentScorecard[name] = {
        totalPredictions: am.totalPredictions,
        directionalPredictions: am.directionalPredictions,
        correct: am.correct,
        incorrect: am.incorrect,
        accuracy: am.accuracy,
        averageReturn: am.averageReturn,
        averageMFE: am.averageMFE,
        averageMAE: am.averageMAE,
        reputation: am.reputation,
        usefulnessScore: am.usefulnessScore,
        regimeBreakdown: am.regimeBreakdown
      };
    }

    /* Attribution summary. */
    const attributions = readJsonl(attributionFile);
    const attrCounts = {};
    for (const a of attributions) {
      const key = a.attribution || 'UNKNOWN';
      attrCounts[key] = (attrCounts[key] || 0) + 1;
    }

    /* Regime performance. */
    const regimePerf = {};
    for (const r of REGIMES) {
      regimePerf[r] = {
        total: regimeMetrics.regimes[r].total,
        accuracy: regimeMetrics.regimes[r].accuracy,
        averageReturn: regimeMetrics.regimes[r].averageReturn
      };
    }

    return {
      predictions: predictions.length,
      resolved: resolved.length,
      unresolved: unresolved.length,
      warming: all.filter((r) => r.type === 'warming').length,

      evidenceStatus: evidence.status,
      evidenceResolvedCount: evidence.resolvedCount,

      taAccuracy: resolved.length > 0 ? round((taCorrect / resolved.length) * 100, 2) : null,
      circuitAccuracy: resolved.length > 0 ? round((circuitCorrect / resolved.length) * 100, 2) : null,
      taAvgReturn: statComp.tradingAgents.mean,
      circuitAvgReturn: statComp.circuitV1.mean,

      valueAdd,

      agentScorecard,

      regimePerformance: regimePerf,

      agreementAnalysis: agree,

      calibration: {
        buckets: calibration.buckets,
        calibrationError: calErr
      },

      bearRiskEffectiveness: bearRisk,

      attribution: attrCounts,

      statisticalComparison: statComp,

      timestamp: Date.now(),
      timestampIso: nowIso(Date.now())
    };
  }

  /* ================================================================= *
   * PUBLIC API
   * ================================================================= */

  return {
    /* Core journal operations. */
    recordPrediction,
    recordPredictionWithIntegrity,
    getUnresolved,
    resolveOutcome,
    resolveAll,
    recordWarmingState,

    /* Attribution. */
    recordAttribution,

    /* Look-ahead protection. */
    validateNoLookAhead,

    /* Read-only summaries. */
    snapshot,
    agreementAnalysis,
    bearRiskEffectiveness,
    computeValueAdd,
    evidenceStatus,
    statisticalComparison,
    calibrationError,
    bootstrapCI,

    /* Agent metrics access. */
    agentMetrics: () => agentMetrics,
    regimeMetrics: () => regimeMetrics,
    calibrationData: () => calibration,

    /* Config / constants (for testing). */
    AGENT_NAMES,
    REGIMES,
    RESOLUTION_HORIZONS,
    CONFIDENCE_BUCKETS,
    EVIDENCE_LABELS,

    /* File paths (for testing). */
    files: {
      counterfactual: counterfactualFile,
      agentMetrics: agentMetricsFile,
      regimeMetrics: regimeMetricsFile,
      calibration: calibrationFile,
      attribution: attributionFile
    }
  };
}

module.exports = {
  createCounterfactualJournal,
  AGENT_NAMES,
  REGIMES,
  RESOLUTION_HORIZONS,
  CONFIDENCE_BUCKETS,
  EVIDENCE_LABELS,
  COUNTERFACTUAL_FILE,
  AGENT_METRICS_FILE,
  REGIME_METRICS_FILE,
  CALIBRATION_FILE,
  ATTRIBUTION_FILE
};
