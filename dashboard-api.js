#!/usr/bin/env node
/**
 * dashboard-api.js — read-only HTTP API for the Circuit paper-trader.
 *
 * Runs NEXT TO the agent (typically on the machine that owns the paper
 * account) and exposes the live portfolio state to the web dashboard.
 *
 * ------------------------------------------------------------------
 * SAFETY — this server is strictly READ-ONLY:
 *   • It only ever READS portfolio.json / trades.jsonl / heartbeat.json /
 *     equity-history.jsonl. It never writes, moves or deletes them.
 *   • It cannot execute trades, cannot modify cash/positions/P&L, and has
 *     no wallet / private-key / signer code path.
 *   • Every response advertises "paper": true.
 * ------------------------------------------------------------------
 *
 * Usage:
 *   node agentd/dashboard-api.js
 *
 * Environment:
 *   PORT                    bind port           (default 8787)
 *   HOST                    bind address        (default 0.0.0.0)
 *   CIRCUIT_AGENT_DATA_DIR  agent data dir      (default ~/.circuit/agents/paper-trader)
 *
 * Endpoints (all GET):
 *   /                    dashboard UI (static, if present next to this file)
 *   /api/health          { ok, service, paper }
 *   /api/portfolio       full portfolio.json object
 *   /api/heartbeat       heartbeat.json object
 *   /api/trades          ledger records, newest first   (?limit=100, max 500)
 *   /api/positions       open positions (from portfolio.json)
 *   /api/performance     portfolio + derived stats
 *   /api/equity          equity history records         (?limit=..., default 500)
 *   /api/candidates      last real discovery scan       (candidates.json)
 *   /api/system          market/execution/wallet state + price sources + errors
 *   /api/rates           current USD/INR rate + INR/SOL conversion info
 *   /api/dashboard       one aggregated payload for the dashboard UI
 *
 * ------------------------------------------------------------------
 * INR DISPLAY LAYER (read-only presentation — never affects the account):
 *   • SOL→INR uses the REAL SOL/USD price the agent already fetched
 *     (heartbeat.json → solPriceUsd) multiplied by a live USD/INR rate.
 *   • The live USD/INR rate comes from open.er-api.com (primary) plus
 *     frankfurter.app / frankfurter.dev (fallbacks) — keyless, real market
 *     data. The last valid rate is cached to ${CIRCUIT_AGENT_DATA_DIR}/
 *     fx-rate-cache.json (the ONLY file this API writes — never
 *     portfolio/trades/heartbeat/equity state) so provider outages keep the
 *     last real rate, flagged "cached": true. After a failed refresh the
 *     next attempt happens ~60 s later (not 5 min). Every payload carries a
 *     top-level `fx` object.
 *   • Original SOL/USD fields are always preserved alongside the new
 *     *Inr mirror fields (e.g. equitySol + equityInr).
 *   • FX_DISABLE=1 disables rate fetching (dev/test of the SOL fallback UI).
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SERVICE = 'paper-portfolio-api';
const PAPER = true; // hard-coded — this API only ever reports a paper account.

const DATA_DIR = process.env.CIRCUIT_AGENT_DATA_DIR ||
  path.join(os.homedir(), '.circuit', 'agents', 'paper-trader');

// Static dashboard files live in ./dashboard next to this script.
const DASHBOARD_DIR = path.join(__dirname, 'dashboard');

const PORT = parseInt(process.env.PORT, 10) > 0 ? parseInt(process.env.PORT, 10) : 8787;
const HOST = process.env.HOST || '0.0.0.0';

/* ------------------------------------------------------------------ *
 * INR display layer (see header). Never touches portfolio/accounting.
 * ------------------------------------------------------------------ */

const fxLib = require('./fx.js');
const FX_CACHE_FILE = path.join(DATA_DIR, 'fx-rate-cache.json');
const FX_DISABLED = process.env.FX_DISABLE === '1'; // dev/test: force SOL fallback UI
const fxManager = fxLib.createFxManager({ cacheFile: FX_CACHE_FILE, refreshMs: 5 * 60 * 1000 });

/* ------------------------------------------------------------------ *
 * Adaptive intelligence (READ-ONLY views of the agent's adaptive layer).
 * These modules only read state files — nothing here writes or trades.
 * ------------------------------------------------------------------ */

const adaptivePolicyLib = require('./adaptive-policy.js');
const regimeDetectorLib = require('./regime-detector.js');
const learnedGatesLib = require('./learned-gates.js');
const experimentsLib = require('./strategy-experiments.js');
const reflectionEngineLib = require('./reflection-engine.js');
const perfAnalyzerLib = require('./performance-analyzer.js');
const integrityLib = require('./price-integrity.js'); // read-only view of integrity state
const tradingAgentsLib = require('./tradingagents-layer.js'); // read-only view of research layer
const atlasEngineLib = require('./atlas/atlas-engine.js'); // read-only ATLAS view

/** Read-only ATLAS validation summary — statistics, checkpoints, evidence state. */
function getAtlasValidation() {
  try {
    const db = new atlasEngineLib.AtlasDb(DATA_DIR);
    const statsLib = require('./atlas/statistics.js');
    const abPaperLib = require('./atlas/ab-paper.js');
    const abPaper = abPaperLib.createABPaper(db);
    const abState = abPaper.state ? abPaper.state() : {};
    const comps = (abState.comparisons || []).map(c => ({ circuitReturn: c.v1Return || 0, atlasReturn: c.atlasReturn || 0 }));
    const matched = statsLib.matchedSampleAnalysis(comps);
    const ef = statsLib.effectSize(matched);
    const test = statsLib.pairedTest(matched.circuitReturns, matched.atlasReturns);
    const circuitCI = statsLib.bootstrapCI(matched.circuitReturns);
    const atlasCI = statsLib.bootstrapCI(matched.atlasReturns);
    const pairedCI = statsLib.pairedBootstrapCI(matched.circuitReturns, matched.atlasReturns);
    const preds = db.predictions();
    const outcomes = db.outcomes();
    const unresolved = preds.length - outcomes.length;
    return {
      mode: (getHeartbeat() && getHeartbeat().atlas) ? getHeartbeat().atlas.mode : 'SHADOW',
      predictions: preds.length,
      resolved: outcomes.length,
      unresolved: Math.max(0, unresolved),
      evidenceState: statsLib.evidenceState(matched.matchedSamples),
      matchedSamples: matched.matchedSamples,
      meanDifference: matched.meanDifference,
      medianDifference: matched.medianDifference,
      standardDeviation: matched.standardDeviation,
      effectSize: ef,
      statisticalTest: test,
      circuitBootstrap: circuitCI,
      atlasBootstrap: atlasCI,
      pairedBootstrap: pairedCI,
      checkpoints: require('./atlas/statistics.js').createCheckpoints(db).loadCheckpoints().slice(-5)
    };
  } catch (_) {
    return { error: 'validation data unavailable' };
  }
}

/** Read-only ATLAS checkpoints — 30/100/200 evidence maturity checkpoints. */
function getAtlasCheckpoints() {
  try {
    const db = new atlasEngineLib.AtlasDb(DATA_DIR);
    const ckpts = require('./atlas/statistics.js').createCheckpoints(db).loadCheckpoints();
    return { checkpoints: ckpts, count: ckpts.length };
  } catch (_) {
    return { checkpoints: [], count: 0 };
  }
}

/** Read-only ATLAS statistical comparison — bootstrap CI, effect size, paired test. */
function getAtlasStatistics() {
  try {
    const db = new atlasEngineLib.AtlasDb(DATA_DIR);
    const statsLib = require('./atlas/statistics.js');
    const abPaperLib = require('./atlas/ab-paper.js');
    const abPaper = abPaperLib.createABPaper(db);
    const abState = abPaper.state ? abPaper.state() : {};
    const comps = (abState.comparisons || []).map(c => ({ circuitReturn: c.v1Return || 0, atlasReturn: c.atlasReturn || 0 }));
    const matched = statsLib.matchedSampleAnalysis(comps);
    const ef = statsLib.effectSize(matched);
    const test = statsLib.pairedTest(matched.circuitReturns, matched.atlasReturns);
    const circuitCI = statsLib.bootstrapCI(matched.circuitReturns, { iterations: 10000 });
    const atlasCI = statsLib.bootstrapCI(matched.atlasReturns, { iterations: 10000 });
    const pairedCI = statsLib.pairedBootstrapCI(matched.circuitReturns, matched.atlasReturns, { iterations: 10000 });
    return {
      matchedSamples: matched.matchedSamples,
      matched,
      effectSize: ef,
      statisticalTest: test,
      circuitBootstrap: circuitCI,
      atlasBootstrap: atlasCI,
      pairedBootstrap: pairedCI,
      evidenceState: statsLib.evidenceState(matched.matchedSamples)
    };
  } catch (_) {
    return { error: 'statistics unavailable' };
  }
}

/** Read-only ATLAS agent scorecard — predictions, accuracy, MFE, MAE, calibration. */
function getAtlasAgents() {
  try {
    const db = new atlasEngineLib.AtlasDb(DATA_DIR);
    const repo = db.reputation();
    const agents = repo.agents || {};
    const result = {};
    for (const [name, rep] of Object.entries(agents)) {
      result[name] = {
        agent: name,
        totalPredictions: rep.totalPredictions || 0,
        directionalPredictions: rep.directionalPredictions || 0,
        correct: rep.correct || 0,
        incorrect: rep.incorrect || 0,
        accuracy: rep.accuracy || rep.winRate || 0,
        winRate: rep.winRate || 0,
        medianReturn: rep.medianReturn || 0,
        mfe: rep.mfe || 0,
        mae: rep.mae || 0,
        avgConfidence: rep.avgConfidence || 0,
        calibrationScore: rep.calibrationScore || 0,
        weight: rep.weights ? rep.weights.global : 1.0
      };
    }
    return result;
  } catch (_) {
    return {};
  }
}

/** Read-only ATLAS regime scorecard — accuracy, expectancy, MFE, MAE by regime. */
function getAtlasRegimes() {
  try {
    const db = new atlasEngineLib.AtlasDb(DATA_DIR);
    const repo = db.reputation();
    const regimes = repo.regimes || {};
    return regimes;
  } catch (_) {
    return {};
  }
}

/** Read-only ATLAS attribution — outcome classification. */
function getAtlasAttribution() {
  try {
    const db = new atlasEngineLib.AtlasDb(DATA_DIR);
    const outcomes = db.outcomes ? db.outcomes() : [];
    const classifications = {};
    for (const o of outcomes) {
      const c = (o && o.classification) || 'UNKNOWN';
      classifications[c] = (classifications[c] || 0) + 1;
    }
    return { classifications, count: outcomes.length, recent: outcomes.slice(-10) };
  } catch (_) {
    return { classifications: {}, count: 0, recent: [] };
  }
}

/** Read-only view of the ATLAS intelligence layer (parallel, advisory). */
function getAtlas() {
  const blank = {
    enabled: false,
    mode: 'SHADOW',
    agents: Array.isArray(atlasEngineLib.AGENTS) ? atlasEngineLib.AGENTS : [],
    lastRunAt: null,
    cycles: 0,
    counters: { candidatesResearched: 0, decisionsLogged: 0, llmCalls: 0, llmFails: 0 },
    latest: null,
    predictions: { n: 0, correct: 0, incorrect: 0, pct: null },
    calibration: null,
    abPaper: null,
    status: 'agent heartbeat not available'
  };
  // Prefer the live heartbeat block (fresh, written by the agent each cycle).
  const h = getHeartbeat();
  if (h && !h.error && h.atlas) return h.atlas;
  // Fallback: persisted ATLAS files.
  try {
    const db = new atlasEngineLib.AtlasDb(DATA_DIR);
    const preds = db.predictions();
    const recent = preds.filter((p) => p && p.mint).slice(-5);
    const counts = preds.filter((p) => p && p.direction && p.direction !== 'unknown').length;
    const calibration = readJson(path.join(DATA_DIR, 'atlas-calibration.json'));
    const abPaper = readJson(path.join(DATA_DIR, 'atlas-ab-paper.json'));
    return Object.assign({}, blank, {
      enabled: false,
      note: 'atlas heartbeat not available — showing persisted predictions',
      predictions: { n: counts, correct: 0, incorrect: 0, pct: null, recent },
      calibration: calibration || null,
      abPaper: abPaper || null
    });
  } catch (_) {
    return blank;
  }
}

/** Read-only view of the TradingAgents research layer (Requirement 22). */
function getTradingAgents() {
  const blank = {
    enabled: false,
    mode: 'SHADOW',
    agents: [],
    lastRunAt: null,
    lastCommitAt: null,
    cycles: 0,
    counters: { candidatesResearched: 0, positionsResearched: 0, decisionsLogged: 0, failedAgents: 0, llmNotes: 0 },
    accuracy: { n: 0, correct: 0, incorrect: 0, pct: null },
    latest: null,
    lastPositionAssessments: [],
    lastErrors: []
  };
  // Prefer the live heartbeat block (fresh, written by the agent each cycle).
  const h = getHeartbeat();
  if (h && !h.error && h.tradingAgents) return h.tradingAgents;
  // Fallback: persisted metrics + the tail of the decisions log.
  const metrics = readJson(path.join(DATA_DIR, tradingAgentsLib.METRICS_FILE));
  const decisions = readJsonl(path.join(DATA_DIR, tradingAgentsLib.DECISIONS_FILE), 5).records || [];
  const candidateRows = decisions.filter((r) => r && r.type === 'candidate');
  const latest = candidateRows.length ? candidateRows[0] : null;
  const acc = metrics && metrics.totals && metrics.totals.n
    ? Math.round((metrics.totals.correct / metrics.totals.n) * 1000) / 10 : null;
  return Object.assign({}, blank, {
    note: 'agent heartbeat not available — showing persisted research state',
    cycles: metrics ? Number(metrics.rowsEvaluated) || 0 : 0,
    accuracy: metrics && metrics.totals ? {
      n: metrics.totals.n, correct: metrics.totals.correct, incorrect: metrics.totals.incorrect, pct: acc,
      byAgent: metrics.byAgent || {}, byRecommendation: metrics.byRecommendation || {},
      rowsEvaluated: metrics.rowsEvaluated || 0, lastEvaluatedAt: metrics.lastEvaluatedAt || null
    } : blank.accuracy,
    latest: latest ? {
      ts: latest.ts, symbol: latest.symbol, mint: latest.mint,
      researchScore: latest.researchScore, circuitScore: latest.circuitScore,
      recommendation: latest.researchRecommendation, consensus: latest.consensus,
      riskLevel: latest.riskLevel, dataQuality: latest.dataQuality,
      circuitDecision: latest.circuitDecision, researchMode: latest.mode,
      technicalScore: latest.technicalScore, quantScore: latest.quantScore,
      sentimentScore: latest.sentimentScore, marketScore: latest.marketScore,
      bullScore: latest.bullScore, bearRisk: latest.bearRisk,
      warnings: Array.isArray(latest.warnings) ? latest.warnings : []
    } : null,
    lastPositionAssessments: decisions.filter((r) => r && r.type === 'position').slice(0, 5).map((r) => ({
      ts: r.ts, symbol: r.symbol, mint: r.mint,
      assessment: r.positionAssessment, riskLevel: r.riskLevel, dataQuality: r.dataQuality
    }))
  });
}

/** Read-only TradingAgents validation metrics (§22). */
function getTradingAgentsMetrics() {
  const h = getHeartbeat();
  if (h && !h.error && h.tradingAgentsValidation) return h.tradingAgentsValidation;
  // Fallback: read persisted files.
  try {
    const counterfactual = readJson(path.join(DATA_DIR, tradingAgentsLib.counterfactualLib.COUNTERFACTUAL_FILE));
    const agentMetrics = readJson(path.join(DATA_DIR, tradingAgentsLib.counterfactualLib.AGENT_METRICS_FILE));
    const regimeMetrics = readJson(path.join(DATA_DIR, tradingAgentsLib.counterfactualLib.REGIME_METRICS_FILE));
    const calibration = readJson(path.join(DATA_DIR, tradingAgentsLib.counterfactualLib.CALIBRATION_FILE));
    return {
      note: 'agent heartbeat not available — showing persisted validation state',
      agentMetrics: agentMetrics || null,
      regimeMetrics: regimeMetrics || null,
      calibration: calibration || null
    };
  } catch (_) {
    return { note: 'no validation data available yet' };
  }
}

/** Read-only TradingAgents agent-by-agent scorecard (§22). */
function getTradingAgentsAgents() {
  const metrics = getTradingAgentsMetrics();
  if (metrics && metrics.agentMetrics && metrics.agentMetrics.agents) {
    return metrics.agentMetrics.agents;
  }
  return {};
}

/** Read-only TradingAgents attribution log (§22). */
function getTradingAgentsAttribution() {
  const res = readJsonl(path.join(DATA_DIR, tradingAgentsLib.counterfactualLib.ATTRIBUTION_FILE), 100);
  return { records: res.records || [], count: (res.records || []).length };
}

/** Read-only view of the agent's price-integrity state (Requirement 10). */
function getIntegrity() {
  const blankCounters = {
    suspiciousObservations: 0,
    rejectedObservations: 0,
    pairChangesDetected: 0,
    sourceDivergenceEvents: 0
  };
  const blank = {
    enabled: false,
    status: 'unavailable',
    lastCheckAt: null,
    counters: blankCounters,
    quarantined: [],
    lastWarning: null,
    events: []
  };
  // Prefer the live heartbeat block (fresh, written by the agent each cycle),
  // then fall back to the persisted price-integrity.json state file.
  const h = getHeartbeat();
  if (h && !h.error && h.integrity) return h.integrity;
  const f = readJson(path.join(DATA_DIR, integrityLib.FILE_NAME));
  if (!f) {
    return Object.assign({}, blank, {
      note: 'price-integrity.json not written yet — the agent records integrity state while monitoring open positions'
    });
  }
  if (f.error) return Object.assign({}, blank, { error: f.error });
  return integrityLib.summarize(f);
}

/** Aggregated read-only view of the adaptive layer for the dashboard. */
function getAdaptive() {
  const hb = getHeartbeat();
  const enabled = !!(hb && hb.adaptive && hb.adaptive.enabled);
  const policy = adaptivePolicyLib.loadPolicy(DATA_DIR);
  const regime = regimeDetectorLib.loadRegimeState(DATA_DIR);
  const gates = learnedGatesLib.gateSummary(learnedGatesLib.loadGates(DATA_DIR));
  const versions = experimentsLib.loadVersions(DATA_DIR);
  const baseline = experimentsLib.effectiveBaseline(versions);
  const expSummary = experimentsLib.summary(DATA_DIR);
  const lessons = reflectionEngineLib.getRecentLessons(DATA_DIR, 6);
  const rawLessons = readJsonl(path.join(DATA_DIR, 'lessons.jsonl'), 8).records;
  const policyChanges = reflectionEngineLib.loadPolicyChanges(DATA_DIR).slice(-12);
  const snap = readJsonl(path.join(DATA_DIR, 'performance-snapshots.jsonl'), 1).records[0] || null;
  const schedule = (hb && hb.adaptive) ? {
    lastAgentLoopAt: hb.adaptive.lastAgentLoopAt,
    nextAgentLoopAt: hb.adaptive.nextAgentLoopAt,
    lastReflectionAt: hb.adaptive.lastReflectionAt,
    nextReflectionAt: hb.adaptive.nextReflectionAt
  } : null;
  return {
    enabled,
    policy: {
      mode: policy.mode,
      minScore: policy.minScore,
      maxBuys: policy.maxBuys,
      buysThisSession: policy.buysThisSession || 0,
      strategyVersion: policy.strategyVersion,
      regime: policy.regime,
      confidence: policy.confidence,
      reason: policy.reason,
      sizeMultiplier: policy.sizeMultiplier,
      source: policy.source,
      setAt: policy.setAt,
      expiresAt: policy.expiresAt
    },
    regime: {
      regime: regime.regime,
      confidence: regime.confidence,
      reasoning: regime.reasoning,
      detectedAt: regime.detectedAt,
      validUntil: regime.validUntil
    },
    baseline,
    gates,
    versions,
    experiments: expSummary,
    lessons: lessons.concat(rawLessons.map((l) => ({
      type: l.type,
      summary: l.summary,
      ts: l.ts
    }))),
    policyChanges: policyChanges.map((c) => ({
      policyChangeId: c.policyChangeId,
      strategyVersion: c.strategyVersion,
      timestamp: c.timestamp,
      parameter: c.parameter,
      oldValue: c.oldValue,
      newValue: c.newValue,
      reason: c.reason,
      grade: c.grade,
      afterWinRate: c.afterWinRate,
      tradeSample: c.tradeSample
    })),
    performance: snap ? {
      ts: snap.ts,
      allTime: snap.metrics,
      week: snap.metrics.week
    } : null,
    schedule,
    marketHealth: (hb && hb.adaptive && hb.adaptive.marketHealth) || null
  };
}

/** Current expectancy / drawdown / streaks from the last performance snapshot. */
function adaptivePerfSummary() {
  const a = getAdaptive();
  const m = a.performance && (a.performance.week || a.performance.allTime);
  if (!m) return null;
  // Drawdown physically cannot exceed 100% for a long-only paper account.
  // Backstop: clamp stale/corrupt snapshot values (e.g. a pre-fix -832%) to
  // [-100, 0] so the dashboard never shows an impossible number.
  const dd = Number(m.maxDrawdownPct) || 0;
  const maxDrawdownPct = Math.max(-100, Math.min(0, dd));
  return {
    winRate: m.winRate,
    expectancyPct: m.expectancyPct,
    maxDrawdownPct,
    lossStreak: m.lossStreak,
    winStreak: m.winStreak,
    n: m.n
  };
}

/** Real SOL/USD from the agent heartbeat (already fetched by the agent). */
function heartbeatSolUsd(hb) {
  const v = hb && hb.solPriceUsd;
  return Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null;
}

function solUsdFor(payload) {
  const hb = (payload && (payload.heartbeat || payload.performance)) || getHeartbeat();
  return heartbeatSolUsd(hb);
}

/** Top-level `fx` block attached to every payload. */
function fxMeta(payload) {
  const solUsd = solUsdFor(payload);
  const meta = {
    available: false,
    usdInr: null,
    inrPerSol: null,       // = solUsd × usdInr — SOL→INR multiplier
    solUsd,
    source: null,
    fetchedAt: null,
    cached: null,          // true = last valid rate, not a fresh fetch
    lastError: FX_DISABLED ? 'FX disabled by FX_DISABLE=1 (dev/test)' : (fxManager.lastError || null)
  };
  const r = FX_DISABLED ? null : fxManager.current();
  if (r && Number(r.usdInr) > 0) {
    meta.available = true;
    meta.usdInr = r.usdInr;
    meta.inrPerSol = solUsd ? fxLib.inrPerSolOf(solUsd, r.usdInr) : null;
    meta.source = r.source;
    meta.fetchedAt = r.fetchedAt;
    meta.cached = !!r.cached;
  }
  return meta;
}

const SOL_MONEY_FIELDS = ['startingCapitalSol', 'cashSol', 'investedSol', 'marketValueSol',
  'equitySol', 'realizedPnlSol', 'unrealizedPnlSol', 'totalPnlSol',
  'avgWinSol', 'avgLossSol', 'bestTradeSol', 'worstTradeSol'];

/** Add *Inr mirrors for every present *Sol monetary field on one object. */
function moneyMirrors(o, fx) {
  if (!o || typeof o !== 'object' || !fx.inrPerSol) return;
  for (const key of SOL_MONEY_FIELDS) {
    if (typeof o[key] === 'number' && Number.isFinite(o[key])) {
      o[key.replace(/Sol$/, 'Inr')] = fxLib.round(fxLib.inrFromSol(o[key], fx.inrPerSol), 4);
    }
  }
}

/** Add *Inr mirrors to one open position (keeps all SOL/USD originals). */
function positionMirrors(pos, fx) {
  if (!pos || typeof pos !== 'object') return;
  moneyMirrors(pos, fx);
  if (fx.usdInr) {
    const priceInr = (vUsd, vSol) => {
      const fromUsd = Number.isFinite(vUsd) ? fxLib.inrFromUsd(vUsd, fx.usdInr) : null;
      if (fromUsd != null) return fxLib.round(fromUsd, 8);
      return Number.isFinite(vSol) && fx.inrPerSol ? fxLib.round(fxLib.inrFromSol(vSol, fx.inrPerSol), 8) : null;
    };
    pos.entryPriceInr = priceInr(pos.entryPriceUsd, pos.entryPriceSol);
    pos.currentPriceInr = priceInr(pos.currentPriceUsd, pos.currentPriceSol);
    if (Number.isFinite(pos.unrealizedPnlSol) && fx.inrPerSol) {
      pos.unrealizedPnlInr = fxLib.round(fxLib.inrFromSol(pos.unrealizedPnlSol, fx.inrPerSol), 4);
    }
  }
}

/** Add *Inr mirrors to one ledger trade row. */
function tradeMirrors(t, fx) {
  if (!t || typeof t !== 'object') return;
  if (Number.isFinite(t.valueSol) && fx.inrPerSol) t.valueInr = fxLib.round(fxLib.inrFromSol(t.valueSol, fx.inrPerSol), 4);
  if (Number.isFinite(t.realizedPnlSol) && fx.inrPerSol) t.realizedPnlInr = fxLib.round(fxLib.inrFromSol(t.realizedPnlSol, fx.inrPerSol), 4);
  if (fx.usdInr) {
    const fromUsd = Number.isFinite(t.priceUsd) ? fxLib.inrFromUsd(t.priceUsd, fx.usdInr) : null;
    t.priceInr = fromUsd != null ? fxLib.round(fromUsd, 8)
      : (Number.isFinite(t.price) && fx.inrPerSol ? fxLib.round(fxLib.inrFromSol(t.price, fx.inrPerSol), 8) : null);
  }
}

/** Add *Inr mirrors to one candidate row. */
function candidateMirrors(c, fx) {
  if (!c || typeof c !== 'object') return;
  if (Number.isFinite(c.priceUsd) && fx.usdInr) c.priceInr = fxLib.round(fxLib.inrFromUsd(c.priceUsd, fx.usdInr), 10);
}

function mapItems(arr, fn, fx) {
  if (Array.isArray(arr)) for (const item of arr) fn(item, fx);
}

/** Attach the `fx` block + INR mirrors to any response payload. */
function decorate(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const fx = fxMeta(payload);
  payload.fx = fx;

  for (const key of ['portfolio', 'performance']) {
    const o = payload[key];
    if (o && typeof o === 'object' && !o.error) {
      moneyMirrors(o, fx);
      mapItems(o.positions, positionMirrors, fx);
    }
  }
  if (payload.heartbeat && typeof payload.heartbeat === 'object') {
    moneyMirrors(payload.heartbeat, fx);
    mapItems(payload.heartbeat.positions, positionMirrors, fx);
  }
  if (Array.isArray(payload.positions)) mapItems(payload.positions, positionMirrors, fx);
  if (Array.isArray(payload.trades)) mapItems(payload.trades, tradeMirrors, fx);
  if (Array.isArray(payload.candidates)) mapItems(payload.candidates, candidateMirrors, fx);
  if (Array.isArray(payload.equity)) {
    for (const rec of payload.equity) {
      if (rec && typeof rec === 'object' && Number.isFinite(rec.equitySol) && fx.inrPerSol) {
        rec.equityInr = fxLib.round(fxLib.inrFromSol(rec.equitySol, fx.inrPerSol), 4);
      }
    }
  }
  return payload;
}

/* ------------------------------------------------------------------ *
 * File readers (read-only). Missing/corrupt files degrade gracefully.
 * ------------------------------------------------------------------ */

function readJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    return obj && typeof obj === 'object' ? obj : null;
  } catch (err) {
    return { error: `unreadable ${path.basename(file)}: ${err.message}` };
  }
}

/** Read the LAST n records of a JSONL file (newest-first output). */
function readJsonl(file, n) {
  if (!fs.existsSync(file)) return { records: [], error: null };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { records: [], error: err.message };
  }
  const records = [];
  const lines = text.split('\n');
  const take = Math.max(0, Math.min(lines.length, n));
  for (let i = lines.length - 1; i >= 0 && records.length < take; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try { records.push(JSON.parse(line)); } catch (_) { /* skip corrupt line */ }
  }
  return { records, error: null };
}

const limit = (q) => {
  const n = parseInt(q && q.limit, 10);
  return Number.isFinite(n) ? Math.max(1, Math.min(n, 500)) : 100;
};

/* ------------------------------------------------------------------ *
 * Handlers.
 * ------------------------------------------------------------------ */

function getPortfolio() { return readJson(path.join(DATA_DIR, 'portfolio.json')); }
function getHeartbeat() { return readJson(path.join(DATA_DIR, 'heartbeat.json')); }

function getPerformance() {
  const p = getPortfolio();
  if (!p || p.error) return p || { error: 'no portfolio yet' };
  if (!p.positions && p.positions !== undefined) return p;
  // Normalize positions array + include marketValue fields if absent.
  const perf = Object.assign({}, p);
  perf.positions = Array.isArray(p.positions) ? p.positions : [];
  perf.openPositions = perf.positions.length;
  if (typeof perf.marketValueSol !== 'number') {
    perf.marketValueSol = perf.positions.reduce((s, x) => s + (x.marketValueSol || 0), 0);
  }
  return perf;
}

function getPositions() {
  const p = getPortfolio();
  if (!p || p.error) return { positions: [], error: p && p.error ? p.error : 'no portfolio yet' };
  return { positions: Array.isArray(p.positions) ? p.positions : [], error: null };
}

function getEquity(n) {
  const res = readJsonl(path.join(DATA_DIR, 'equity-history.jsonl'), n || 500);
  if (!fs.existsSync(path.join(DATA_DIR, 'equity-history.jsonl'))) {
    return {
      records: [],
      error: null,
      note: 'equity-history.jsonl does not exist yet — the agent records it automatically as it runs'
    };
  }
  return res;
}

function getTrades(n) {
  return readJsonl(path.join(DATA_DIR, 'trades.jsonl'), n);
}

function getCandidates() {
  const c = readJson(path.join(DATA_DIR, 'candidates.json'));
  if (!c) return { candidates: [], count: 0, error: null, note: 'candidates.json not written yet — the agent writes it after each discovery scan' };
  if (c.error) return { candidates: [], count: 0, error: c.error };
  return {
    scannedAt: c.scannedAt || null,
    scan: c.scan || 0,
    count: c.count || 0,
    openPositions: c.openPositions || 0,
    maxPositions: c.maxPositions || 0,
    candidates: Array.isArray(c.candidates) ? c.candidates : [],
    error: null
  };
}

function getSystem() {
  const h = getHeartbeat();
  const cand = getCandidates();
  const lock = readJson(path.join(DATA_DIR, 'agent.lock'));
  return {
    heartbeat: h && !h.error ? h : null,
    market: h && h.market ? h.market : 'REAL SOLANA',
    execution: h && h.execution ? h.execution : 'PAPER ONLY',
    wallet: h && h.wallet ? h.wallet : 'DISABLED',
    broadcast: h && h.broadcast ? h.broadcast : 'DISABLED',
    solPriceUsd: h && h.solPriceUsd ? h.solPriceUsd : null,
    priceSources: h && Array.isArray(h.priceSources) ? h.priceSources : [],
    lastErrors: h && Array.isArray(h.lastErrors) ? h.lastErrors : [],
    candidates: cand,
    lock: lock && !lock.error ? lock : null
  };
}

function getDashboard() {
  const [portfolio, heartbeat, perf] = [getPortfolio(), getHeartbeat(), getPerformance()];
  const trades = getTrades(100);
  const equity = getEquity(500);
  const candidates = getCandidates();
  const system = getSystem();
  return {
    service: SERVICE,
    paper: PAPER,
    dataDir: DATA_DIR,
    portfolio: portfolio && !portfolio.error ? portfolio : null,
    heartbeat: heartbeat && !heartbeat.error ? heartbeat : null,
    performance: perf && !perf.error ? perf : null,
    trades: trades.records || [],
    equity: equity.records || [],
    candidates: candidates.candidates || [],
    candidatesMeta: {
      scannedAt: candidates.scannedAt || null,
      scan: candidates.scan || 0,
      count: candidates.count || 0,
      openPositions: candidates.openPositions || 0,
      maxPositions: candidates.maxPositions || 0
    },
    priceSources: system.priceSources || [],
    lastErrors: system.lastErrors || [],
    market: system.market,
    execution: system.execution,
    wallet: system.wallet,
    broadcast: system.broadcast,
    solPriceUsd: system.solPriceUsd,
    integrity: getIntegrity(),
    tradingAgents: getTradingAgents(),
    tradingAgentsValidation: getTradingAgentsMetrics(),
    adaptive: getAdaptive(),
    adaptivePerf: adaptivePerfSummary(),
    atlas: getAtlas(),
    stale: null,
    fetchedAt: Date.now()
  };
}

/* ------------------------------------------------------------------ *
 * Static dashboard serving (same-origin option: http://host:8787/).
 * ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function serveStatic(req, res) {
  let p = new URL(req.url, 'http://localhost').pathname || '/';
  if (p === '/') p = '/index.html';
  // No traversal outside DASHBOARD_DIR.
  const file = path.normalize(path.join(DASHBOARD_DIR, path.normalize(p).replace(/^(\.\.[/\\])+/, '')));
  if (!file.startsWith(DASHBOARD_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    send(res, 404, { error: 'not found' });
    return;
  }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  try {
    const body = fs.readFileSync(file);
    res.writeHead(200, {
      'Content-Type': type,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    });
    res.end(body);
  } catch (err) {
    send(res, 500, { error: err.message });
  }
}

/* ------------------------------------------------------------------ *
 * HTTP plumbing.
 * ------------------------------------------------------------------ */

function send(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store'
  });
  res.end(body + '\n');
}

const ROUTES = {
  '/api/health': () => ({ ok: true, service: SERVICE, paper: PAPER, dataDir: DATA_DIR, time: Date.now() }),
  '/api/portfolio': () => {
    const p = getPortfolio();
    if (!p) return { ok: false, paper: PAPER, error: 'no portfolio yet — run the paper-trader agent first' };
    if (p.error) return { ok: false, paper: PAPER, error: p.error };
    return { ok: true, paper: PAPER, portfolio: p };
  },
  '/api/heartbeat': () => {
    const h = getHeartbeat();
    if (!h) return { ok: false, paper: PAPER, error: 'no heartbeat yet — run the paper-trader agent first' };
    if (h.error) return { ok: false, paper: PAPER, error: h.error };
    return { ok: true, paper: PAPER, heartbeat: h };
  },
  '/api/trades': (q) => {
    const res = getTrades(limit(q));
    return { ok: true, paper: PAPER, count: res.records.length, trades: res.records };
  },
  '/api/positions': () => {
    const r = getPositions();
    if (r.error) return { ok: false, paper: PAPER, error: r.error };
    return { ok: true, paper: PAPER, count: r.positions.length, positions: r.positions };
  },
  '/api/performance': () => {
    const p = getPerformance();
    if (!p || p.error) return { ok: false, paper: PAPER, error: (p && p.error) || 'no portfolio yet' };
    return { ok: true, paper: PAPER, performance: p };
  },
  '/api/equity': (q) => {
    const res = getEquity(limit(q));
    return { ok: true, paper: PAPER, count: res.records.length, equity: res.records };
  },
  '/api/candidates': () => {
    const c = getCandidates();
    if (c.error) return { ok: false, paper: PAPER, error: c.error };
    return { ok: true, paper: PAPER, scannedAt: c.scannedAt, scan: c.scan, count: c.count, candidates: c.candidates };
  },
  '/api/system': () => ({ ok: true, paper: PAPER, ...getSystem() }),
  '/api/rates': () => {
    const fx = fxMeta({});
    return {
      ok: true,
      paper: PAPER,
      fx,
      formula: 'INR = SOL × (solPriceUsd × usdInr);  INR = USD × usdInr',
      label: fx.available && fx.usdInr ? `1 USD = ₹${fx.usdInr.toFixed(2)}` : null
    };
  },
  '/api/adaptive': () => {
    const a = getAdaptive();
    return { ok: true, paper: PAPER, adaptive: a, perf: adaptivePerfSummary() };
  },
  '/api/integrity': () => ({ ok: true, paper: PAPER, integrity: getIntegrity() }),
  '/api/tradingagents': () => ({ ok: true, paper: PAPER, tradingAgents: getTradingAgents() }),
  '/api/tradingagents/metrics': () => ({ ok: true, paper: PAPER, metrics: getTradingAgentsMetrics() }),
  '/api/tradingagents/agents': () => ({ ok: true, paper: PAPER, agents: getTradingAgentsAgents() }),
  '/api/tradingagents/attribution': () => ({ ok: true, paper: PAPER, attribution: getTradingAgentsAttribution() }),
  '/api/atlas': () => ({ ok: true, paper: PAPER, atlas: getAtlas() }),
  '/api/atlas/validation': () => ({ ok: true, paper: PAPER, validation: getAtlasValidation() }),
  '/api/atlas/checkpoints': () => ({ ok: true, paper: PAPER, checkpoints: getAtlasCheckpoints() }),
  '/api/atlas/statistics': () => ({ ok: true, paper: PAPER, statistics: getAtlasStatistics() }),
  '/api/atlas/agents': () => ({ ok: true, paper: PAPER, agents: getAtlasAgents() }),
  '/api/atlas/regimes': () => ({ ok: true, paper: PAPER, regimes: getAtlasRegimes() }),
  '/api/atlas/attribution': () => ({ ok: true, paper: PAPER, attribution: getAtlasAttribution() }),
  '/api/dashboard': () => getDashboard()
};

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const pathname = u.pathname;
  const q = Object.fromEntries(u.searchParams);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    });
    res.end();
    return;
  }

  if (req.method !== 'GET') {
    send(res, 405, { ok: false, paper: PAPER, error: 'method not allowed — this API is read-only (GET only)' });
    return;
  }

  const handler = ROUTES[pathname];
  if (!handler) {
    if (pathname.startsWith('/api/')) {
      send(res, 404, { ok: false, paper: PAPER, error: `unknown endpoint ${pathname}` });
    } else {
      serveStatic(req, res);
    }
    return;
  }

  try {
    let out = Object.assign({}, handler(q));
    if (out && typeof out === 'object' && !out.error) out = decorate(out);
    send(res, 200, out);
  } catch (err) {
    send(res, 500, { ok: false, paper: PAPER, error: err.message });
  }
});

if (!FX_DISABLED) fxManager.start();
server.listen(PORT, HOST, () => {
  console.log(`Paper Portfolio API running`);
  console.log(`http://${HOST}:${PORT}`);
  console.log(`data dir: ${DATA_DIR}`);
  console.log(`read-only mode — paper trading account is never modified by this API`);
  if (FX_DISABLED) {
    console.log('USD/INR fetching disabled (FX_DISABLE=1) — dashboard shows SOL/USD');
    return;
  }
  // Background: load/refresh the live USD/INR rate (cached on failure).
  fxManager.refresh().then((r) => {
    if (r) {
      console.log(`USD/INR rate: ${r.usdInr.toFixed(4)} (source ${r.source}${r.cached ? ', CACHED — live refresh failed' : ''})`);
    } else {
      console.log('USD/INR rate unavailable yet — dashboard will fall back to SOL/USD');
    }
  }).catch((err) => {
    console.log(`USD/INR rate refresh failed — dashboard falls back to SOL/USD: ${err.message}`);
  });
});
