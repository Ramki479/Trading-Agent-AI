#!/usr/bin/env node
/**
 * reflection-engine.js — Circuit reflect equivalent (Tier 2): the deep
 * self-improvement cycle that runs every 4 hours.
 *
 * Deterministic (no LLM required; optional LLM hook lives in llm-adapter.js
 * and is never needed for the engine to function). Each cycle:
 *
 *   1. Performance snapshot  — full metric set + breakdowns → data/performance-snapshots.jsonl
 *   2. Grade expired policy changes — before/after comparison with a 6-way
 *      classification (STRONGLY_POSITIVE … INSUFFICIENT_DATA) → data/reflection_log.jsonl
 *   3. Rollback — promoted changes graded STRONGLY_NEGATIVE are rolled back
 *      to their parent policy (never touches safety controls)
 *   4. Lessons — patterns (exit reasons, time-of-day, regime, repeat failures)
 *      → data/lessons.jsonl (append-only, deduped within 24h)
 *   5. Recommendations — candidate policy changes proposed through the
 *      strategy-experiments approval workflow (PROPOSED → BACKTESTING …)
 *
 * NEVER edits source code. Every output is a data file or a schema-validated
 * candidate that must pass backtest + shadow + approval.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const perf = require('./performance-analyzer.js');
const gatesLib = require('./learned-gates.js');
const experiments = require('./strategy-experiments.js');

const REFLECTION_LOG = 'reflection_log.jsonl';
const LESSONS_LOG = 'lessons.jsonl';
const SNAPSHOTS_LOG = 'performance-snapshots.jsonl';

const MS_DAY = 24 * 3600 * 1000;
const MS_WEEK = 7 * MS_DAY;

const GRADES = ['STRONGLY_POSITIVE', 'POSITIVE', 'NEUTRAL', 'NEGATIVE', 'STRONGLY_NEGATIVE', 'INSUFFICIENT_DATA'];
const MIN_GRADE_SAMPLES = 5;
const CHANGE_LOOKBACK_MS = MS_DAY;        // "before" window: 24h before the change
const CHANGE_EVAL_MAX_MS = MS_WEEK;       // grade no later than 7d after the change

function file(dataDir, name) {
  return path.join(dataDir, name);
}
function appendLine(filePath, obj) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(obj) + '\n');
  } catch (_) { /* best effort */ }
}
function readLines(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
      .filter(Boolean);
  } catch (_) { return []; }
}

/* ------------------------------------------------------------------ *
 * Policy-change log (data/reflection_log.jsonl).
 * ------------------------------------------------------------------ */

/** Log an applied adaptive change for later grading. */
function logPolicyChange(dataDir, change, opts = {}) {
  const gradeDelayMs = opts.gradeDelayMs || 4 * 3600 * 1000; // 4h like upstream
  const entry = {
    type: 'policy-change',
    policyChangeId: change.policyChangeId || null,
    strategyVersion: change.strategyVersion || 'V1',
    timestamp: opts.timestamp ? new Date(opts.timestamp).toISOString() : new Date().toISOString(),
    parameter: change.parameter,
    oldValue: change.oldValue,
    newValue: change.newValue,
    reason: change.reason || '',
    evidence: change.evidence || {},
    gradeAt: new Date(Date.now() + gradeDelayMs).toISOString(),
    grade: null,
    afterWinRate: null,
    afterExpectancyPct: null,
    tradeSample: null
  };
  appendLine(file(dataDir, REFLECTION_LOG), entry);
  return entry;
}

function loadPolicyChanges(dataDir) {
  return readLines(file(dataDir, REFLECTION_LOG)).filter((l) => l && l.type === 'policy-change');
}

function updateLogEntry(dataDir, timestamp, patch) {
  try {
    const p = file(dataDir, REFLECTION_LOG);
    const lines = readLines(p);
    const updated = lines.map((l) => (l && l.timestamp === timestamp ? Object.assign({}, l, patch) : l));
    fs.writeFileSync(p, updated.map((l) => JSON.stringify(l)).join('\n') + (updated.length ? '\n' : ''));
  } catch (_) { /* best effort */ }
}

/* ------------------------------------------------------------------ *
 * Grading.
 * ------------------------------------------------------------------ */

/**
 * Classify a change by comparing before/after performance windows.
 * @param {object} change
 * @param {Array} tradesBefore closed trades in the 24h before the change
 * @param {Array} tradesAfter  closed trades between the change and now
 * @returns {{ grade, before, after, deltaWinRatePts }}
 */
function classifyChange(change, tradesBefore, tradesAfter, cfg = {}) {
  const minSamples = cfg.minGradeSamples || MIN_GRADE_SAMPLES;
  const before = perf.computeMetrics(tradesBefore);
  const after = perf.computeMetrics(tradesAfter);

  if (after.n < minSamples) {
    return { grade: 'INSUFFICIENT_DATA', before, after, deltaWinRatePts: null };
  }
  const delta = after.winRate - before.winRate;
  let grade = 'NEUTRAL';
  if (delta >= 15 && after.expectancyPct > before.expectancyPct) grade = 'STRONGLY_POSITIVE';
  else if (delta >= 5 && after.expectancyPct >= before.expectancyPct - 0.5) grade = 'POSITIVE';
  else if (delta <= -15) grade = 'STRONGLY_NEGATIVE';
  else if (delta <= -5) grade = 'NEGATIVE';
  return { grade, before, after, deltaWinRatePts: Math.round(delta * 10) / 10 };
}

/**
 * Grade every expired, ungraded policy change. Persists grades back into the
 * log. Returns the graded records.
 */
function gradeExpiredChanges(dataDir, closedTrades, cfg = {}) {
  const now = Date.now();
  const changes = loadPolicyChanges(dataDir)
    .filter((c) => !c.grade && c.gradeAt && Date.parse(c.gradeAt) <= now);
  const graded = [];
  for (const c of changes) {
    const ts = Date.parse(c.timestamp) || 0;
    const before = closedTrades.filter((t) => t.exitTs >= ts - CHANGE_LOOKBACK_MS && t.exitTs < ts);
    const after = closedTrades.filter((t) => t.exitTs >= ts && t.exitTs <= Math.min(now, ts + CHANGE_EVAL_MAX_MS));
    const res = classifyChange(c, before, after, cfg);
    updateLogEntry(dataDir, c.timestamp, {
      grade: res.grade,
      afterWinRate: res.after.n ? Math.round(res.after.winRate * 100) / 100 : null,
      afterExpectancyPct: res.after.expectancyPct,
      tradeSample: res.after.n,
      deltaWinRatePts: res.deltaWinRatePts
    });
    graded.push(Object.assign({}, c, res));
  }
  return graded;
}

/** Recent lessons (graded changes) for dashboard/context. */
function getRecentLessons(dataDir, limit = 10) {
  const changes = loadPolicyChanges(dataDir).filter((c) => c.grade && c.grade !== 'INSUFFICIENT_DATA');
  const out = [];
  const neg = changes.filter((c) => c.grade === 'NEGATIVE' || c.grade === 'STRONGLY_NEGATIVE');
  const pos = changes.filter((c) => c.grade === 'POSITIVE' || c.grade === 'STRONGLY_POSITIVE');
  if (pos.length) {
    out.push({ type: 'POSITIVE', count: pos.length, summary: `${pos.length} change(s) improved performance`, examples: pos.slice(-3).map((p) => `${p.parameter}: ${p.oldValue}→${p.newValue}`) });
  }
  if (neg.length) {
    out.push({ type: 'NEGATIVE', count: neg.length, summary: `${neg.length} change(s) hurt performance — do not repeat`, examples: neg.slice(-3).map((n) => `${n.parameter}: ${n.oldValue}→${n.newValue}`) });
  }
  return out.slice(-limit);
}

/** Has this exact parameter/value change failed recently? (repeat-failure guard) */
function recentlyFailed(dataDir, parameter, newValue, days = 30) {
  const cutoff = Date.now() - days * MS_DAY;
  return loadPolicyChanges(dataDir).some((c) =>
    c.grade === 'NEGATIVE' || c.grade === 'STRONGLY_NEGATIVE') &&
    loadPolicyChanges(dataDir).some((c) =>
      Date.parse(c.timestamp) >= cutoff &&
      (c.grade === 'NEGATIVE' || c.grade === 'STRONGLY_NEGATIVE') &&
      c.parameter === parameter && String(c.newValue) === String(newValue));
}

/* ------------------------------------------------------------------ *
 * Lessons (data/lessons.jsonl).
 * ------------------------------------------------------------------ */

function appendLesson(dataDir, lesson) {
  // Dedupe: don't append the same lesson type+key within 24h.
  const recent = readLines(file(dataDir, LESSONS_LOG)).filter((l) => l && l.type === lesson.type && l.key === lesson.key);
  const last = recent[recent.length - 1];
  if (last && Date.now() - Date.parse(last.ts) < MS_DAY) return null;
  const rec = Object.assign({ ts: new Date().toISOString() }, lesson);
  appendLine(file(dataDir, LESSONS_LOG), rec);
  return rec;
}

function generateLessons(dataDir, { metrics, breakdowns, regime, closedTrades, cfg = {} } = {}) {
  const lessons = [];
  const push = (type, key, summary, data) => {
    const l = appendLesson(dataDir, { type, key, summary, data });
    if (l) lessons.push(l);
  };

  if (metrics.n >= 5) {
    // Worst exit reason.
    const byReason = Object.entries(breakdowns.byExitReason)
      .filter(([, s]) => s.n >= 3)
      .sort((a, b) => a[1].winRate - b[1].winRate);
    if (byReason.length) {
      const [reason, s] = byReason[0];
      push('exit-reason', reason, `Exit reason "${reason}" has the lowest win rate (${s.winRate}% WR, n=${s.n}) — review entry quality when exits cluster here.`, s);
    }
    // Worst time bucket.
    const byTime = Object.entries(breakdowns.byTimeOfDay)
      .filter(([, s]) => s.n >= 3)
      .sort((a, b) => a[1].winRate - b[1].winRate);
    if (byTime.length) {
      const [tod, s] = byTime[0];
      push('time-of-day', tod, `Entries in "${tod}" win ${s.winRate}% (n=${s.n}) — the worst time bucket; prefer tighter gates there.`, s);
    }
    // Regime lesson.
    if (regime && regime.regime && regime.regime !== 'UNKNOWN') {
      push('regime', regime.regime, `Current regime is ${regime.regime} (confidence ${Math.round(regime.confidence * 100)}%) — ${regime.reasoning}.`, regime.data || {});
    }
    // Streak lesson.
    if (metrics.lossStreak >= 3) {
      push('streak', 'loss-streak', `${metrics.lossStreak}-loss streak detected — session policy will go watchOnly until it breaks.`, { lossStreak: metrics.lossStreak });
    }
  }
  return lessons;
}

/* ------------------------------------------------------------------ *
 * Recommendations → experiments (proposed through the approval workflow).
 * ------------------------------------------------------------------ */

/**
 * Deterministic recommendations from current performance. Returns candidate
 * change descriptions; each is then proposed via strategy-experiments.
 */
function generateRecommendations({ metrics, breakdowns, regime, cfg = {} } = {}) {
  const recs = [];
  const minCluster = cfg.gateClusterMinN || gatesLib.MIN_SAMPLES;

  // 1. Losing cluster → tighten its gates (minScore raised within the cluster).
  const byTime = Object.entries(breakdowns.byTimeOfDay).filter(([, s]) => s.n >= minCluster);
  const worst = byTime.filter(([, s]) => s.winRate < 30).sort((a, b) => a[1].winRate - b[1].winRate)[0];
  if (worst) {
    recs.push({
      type: 'gate-update',
      parameter: 'minScore',
      clusterKey: worst[0],
      oldValue: 60,
      newValue: 65,
      priority: 'MEDIUM',
      reason: `Cluster "${worst[0]}" wins only ${worst[1].winRate}% (n=${worst[1].n}) — raise its minScore gate to 65.`,
      evidence: { clusterKey: worst[0], confidence: 0.85, sample: worst[1].n }
    });
  }

  // 2. Overall losing streak → persistent baseline tighten (minScore 60→65).
  if (metrics.n >= 10 && metrics.winRate < 30) {
    recs.push({
      type: 'baseline',
      parameter: 'minScoreBase',
      oldValue: 60,
      newValue: 65,
      priority: 'HIGH',
      reason: `7d win rate ${metrics.winRate}% (n=${metrics.n}) below 30% — raise the persistent minScore floor to 65.`,
      evidence: { winRate: metrics.winRate, n: metrics.n }
    });
  }

  // 3. Dump/recovery regime → shrink the recovery entry size persistently.
  if (regime && (regime.regime === 'dump' || regime.regime === 'recovery') && metrics.n >= 10) {
    recs.push({
      type: 'baseline',
      parameter: 'recoverySizeMultiplier',
      oldValue: 0.5,
      newValue: 0.25,
      priority: 'MEDIUM',
      reason: `${regime.regime.toUpperCase()} regime with ${metrics.n} trades — reduce recovery-regime entry size to 0.25×.`,
      evidence: { regime: regime.regime, n: metrics.n }
    });
  }

  return recs;
}

/**
 * Propose + backtest each recommendation. Returns the created experiments
 * (state: SHADOW if backtest passed, REJECTED otherwise).
 */
function proposeAndValidate(dataDir, recommendations, closedTrades, cfg = {}) {
  const out = [];
  for (const rec of recommendations) {
    // Repeat-failure guard: skip changes of the same param/value that failed before.
    if (recentlyFailed(dataDir, rec.parameter, rec.newValue)) {
      out.push({ skipped: true, parameter: rec.parameter, newValue: rec.newValue, reason: 'repeat of a previously failed change' });
      continue;
    }
    const exp = experiments.createExperiment(dataDir, Object.assign({}, rec, {
      cfg,
      parentVersion: experiments.effectiveBaseline(experiments.loadVersions(dataDir, cfg), cfg).versionId
    }));
    const backtest = experiments.runBacktest(dataDir, exp.id, closedTrades, cfg);
    out.push(Object.assign({}, exp, { backtest }));
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * The reflection cycle.
 * ------------------------------------------------------------------ */

/**
 * Run one full reflection cycle.
 * @param {object} input
 *   dataDir, ledgerRows, cfg, nowMs
 *   onRollback: optional async callback (experimentId, grade, note)
 * @returns {object} report { graded, lessons, recommendations, experiments, metrics, snapshot }
 */
function runReflection(input = {}) {
  const dataDir = input.dataDir;
  const cfg = input.cfg || {};
  const now = input.nowMs || Date.now();

  const ledgerRows = Array.isArray(input.ledgerRows) ? input.ledgerRows : perf.readLedgerFile(path.join(dataDir, 'trades.jsonl'));
  const { closed } = perf.pairTrades(ledgerRows);
  const weekTrades = closed.filter((t) => t.exitTs >= now - MS_WEEK);
  // Real starting capital keeps the equity-curve drawdown % sane (with 0
  // it starts at 0 and negative equity inflates drawdown past 100%).
  const startingCapital = Number(cfg.startingCapitalSol) || 0;
  const metrics = perf.computeMetrics(weekTrades, startingCapital);
  const allMetrics = perf.computeMetrics(closed, startingCapital);
  const breakdowns = perf.standardBreakdowns(weekTrades);

  // 1. Snapshot.
  const snapshot = {
    ts: new Date().toISOString(),
    metrics: Object.assign({}, allMetrics, { week: metrics }),
    breakdowns,
    regime: input.regime || null
  };
  appendLine(file(dataDir, SNAPSHOTS_LOG), snapshot);

  // 2. Grade expired changes.
  const graded = gradeExpiredChanges(dataDir, closed, cfg);

  // 2b. Rollback strongly-negative promoted changes.
  const rolledBack = [];
  for (const g of graded) {
    if (g.grade === 'STRONGLY_NEGATIVE' && g.policyChangeId) {
      const exp = experiments.getExperiment(dataDir, g.policyChangeId);
      if (exp && exp.state === 'PROMOTED') {
        const rb = experiments.rollbackExperiment(dataDir, exp.id, { grade: g.grade, note: `reflection graded STRONGLY_NEGATIVE (ΔWR ${g.deltaWinRatePts}pts, n=${g.tradeSample})` });
        if (rb) rolledBack.push(rb);
      }
    }
  }

  // 3. Lessons.
  const lessons = generateLessons(dataDir, { metrics, breakdowns, regime: input.regime, closedTrades: closed, cfg });

  // 4. Recommendations → experiments.
  const recommendations = generateRecommendations({ metrics, breakdowns, regime: input.regime, cfg });
  const proposed = proposeAndValidate(dataDir, recommendations, closed, cfg);

  return {
    graded,
    rolledBack,
    lessons,
    recommendations,
    experiments: proposed,
    metrics,
    snapshot,
    closedTradeCount: closed.length
  };
}

/** Prune logs older than `days` (default 30, like upstream). */
function prune(dataDir, days = 30) {
  const cutoff = Date.now() - days * MS_DAY;
  for (const name of [REFLECTION_LOG, LESSONS_LOG, SNAPSHOTS_LOG]) {
    try {
      const p = file(dataDir, name);
      const lines = readLines(p).filter((l) => l && Date.parse(l.timestamp || l.ts) >= cutoff);
      fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + (lines.length ? '\n' : ''));
    } catch (_) { /* best effort */ }
  }
}

module.exports = {
  GRADES,
  MIN_GRADE_SAMPLES,
  logPolicyChange,
  loadPolicyChanges,
  classifyChange,
  gradeExpiredChanges,
  getRecentLessons,
  recentlyFailed,
  generateLessons,
  generateRecommendations,
  proposeAndValidate,
  runReflection,
  prune
};