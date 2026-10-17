#!/usr/bin/env node
/**
 * strategy-experiments.js — approval workflow + shadow testing + rollback for
 * persistent adaptive changes (Circuit Tier 2 equivalent, adapted).
 *
 * Every persistent adaptation (baseline threshold change, learned-gate
 * promotion, sizing change) enters:
 *
 *   PROPOSED → BACKTESTING → SHADOW → PENDING_APPROVAL → PROMOTED
 *                                     └→ REJECTED
 *   PROMOTED → (reflection grades it) → ROLLED_BACK on STRONGLY_NEGATIVE
 *
 * Validation is deterministic and data-driven over real closed trades:
 *   - BACKTESTING: candidate entry gates applied to history vs V1 baseline
 *     (win rate / expectancy / profit factor tolerances, min sample).
 *   - WALK-FORWARD (part of backtesting): the same candidate is evaluated on
 *     purged sequential out-of-sample folds. Each fold keeps only trades that
 *     both exited in-fold AND entered in-fold (boundary straddlers are purged
 *     so no outcome is shared across slices). Every evaluated fold must clear
 *     strict OOS bars (default: n>=30 total, PF>1.2, expectancy%>0 per fold).
 *     In-sample edge that does not repeat out-of-sample never promotes.
 *   - SHADOW: hypothetical replay — every closed trade in the shadow window
 *     is recorded with wouldPass, candidate stats compared again.
 *   - PENDING_APPROVAL → PROMOTED only when validation passed AND autoApply
 *     is enabled; otherwise the operator flips adaptive.autoApply in
 *     config.json (the dashboard is strictly read-only — no write endpoint).
 *
 * Promoted baseline changes create a strategy version (V1 → V1.1 → V1.2)
 * with a parent pointer; rollback restores the parent. The system never
 * touches safety controls (SL/TP/cooldown/position limit/paper-only).
 *
 * Persistence (all in the agent data dir, append-only + atomic writes):
 *   data/experiments.jsonl       lifecycle events
 *   data/approvals.jsonl         approval records
 *   data/shadow-trades.jsonl     hypothetical trade replay
 *   data/strategy-versions.json  version chain
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const perf = require('./performance-analyzer.js');
const gatesLib = require('./learned-gates.js');

const STATES = ['PROPOSED', 'BACKTESTING', 'SHADOW', 'PENDING_APPROVAL', 'PROMOTED', 'REJECTED', 'ROLLED_BACK'];

function file(dataDir, name) {
  return path.join(dataDir, name);
}
function appendLine(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n');
}
function readLines(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
      .filter(Boolean);
  } catch (_) { return []; }
}

function nextId(prefix) {
  return prefix + '_' + crypto.randomBytes(6).toString('hex');
}

/* ------------------------------------------------------------------ *
 * Strategy version chain (data/strategy-versions.json).
 * ------------------------------------------------------------------ */

function versionFile(dataDir) { return file(dataDir, 'strategy-versions.json'); }

function defaultVersions(cfg) {
  const maxPositions = cfg.maxPositions || 3;
  return {
    current: 'V1',
    versions: [{
      id: 'V1',
      parentId: null,
      experimentId: null,
      deltas: { minScoreBase: 60, maxBuysBase: maxPositions, recoverySizeMultiplier: 0.5 },
      createdAt: new Date().toISOString(),
      status: 'active'
    }]
  };
}

function loadVersions(dataDir, cfg = {}) {
  try {
    const f = versionFile(dataDir);
    if (fs.existsSync(f)) {
      const v = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (v && v.current && Array.isArray(v.versions) && v.versions.length) return v;
    }
  } catch (_) { /* corrupt → rebuild */ }
  return defaultVersions(cfg);
}

function saveVersions(dataDir, versions) {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const f = versionFile(dataDir);
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(versions, null, 2) + '\n');
    fs.renameSync(tmp, f);
  } catch (_) { /* best effort */ }
}

function currentVersion(versions) {
  return (versions.versions || []).find((v) => v.id === versions.current) || (versions.versions || [])[0];
}

function nextVersionId(versions) {
  const base = 'V1';
  let n = 0;
  for (const v of (versions.versions || [])) {
    const m = /^V1\.(\d+)$/.exec(v.id);
    if (m) n = Math.max(n, parseInt(m[1], 10));
  }
  return base + '.' + (n + 1);
}

/** Effective persistent baseline from the current version (V1 floors + deltas).
 *  bandsBase is the promoted GLOBAL entry-band set (subset of the five gate
 *  params); missing keys fall back to V1. Always within BOUNDS. */
function effectiveBaseline(versions, cfg = {}) {
  const maxPositions = cfg.maxPositions || 3;
  const cur = currentVersion(versions) || {};
  const d = cur.deltas || {};
  const rawBands = (d.bandsBase && typeof d.bandsBase === 'object') ? d.bandsBase : {};
  const bandsBase = {};
  for (const param of gatesLib.GATE_PARAMS) {
    const b = gatesLib.BOUNDS[param];
    const v = Number(rawBands[param]);
    // Stricter-only clamp: minScore/min1h/min5m raise toward b.max,
    // max1h/max5m lower toward b.min; V1 when absent/invalid.
    if (!Number.isFinite(v)) { bandsBase[param] = gatesLib.V1[param]; continue; }
    const lo = param === 'max1h' || param === 'max5m' ? b.min : gatesLib.V1[param];
    const hi = param === 'max1h' || param === 'max5m' ? gatesLib.V1[param] : b.max;
    bandsBase[param] = Math.max(lo, Math.min(hi, v));
  }
  return {
    minScoreBase: Math.max(60, Math.min(90, Number(d.minScoreBase) || 60)),
    maxBuysBase: Math.max(1, Math.min(maxPositions, Number(d.maxBuysBase) || maxPositions)),
    recoverySizeMultiplier: Math.max(0, Math.min(1, Number(d.recoverySizeMultiplier) != null ? Number(d.recoverySizeMultiplier) : 0.5)),
    bandsBase,
    banditLive: Number(d.banditLive) === 1 ? 1 : 0,
    versionId: cur.id || 'V1'
  };
}

/* ------------------------------------------------------------------ *
 * Experiments (data/experiments.jsonl — append-only event log).
 * ------------------------------------------------------------------ */

function loadExperiments(dataDir) {
  const events = readLines(file(dataDir, 'experiments.jsonl'));
  const byId = new Map();
  for (const e of events) {
    const key = e.experimentId || e.id;
    byId.set(key, Object.assign(byId.get(key) || {}, e));
  }
  return Array.from(byId.values());
}

function getExperiment(dataDir, id) {
  return loadExperiments(dataDir).find((e) => e.id === id) || null;
}

function transition(dataDir, id, patch) {
  const event = Object.assign({ experimentId: id, ts: new Date().toISOString() }, patch);
  appendLine(file(dataDir, 'experiments.jsonl'), event);
  return event;
}

/* ------------------------------------------------------------------ *
 * Approvals (data/approvals.jsonl — append-only).
 * ------------------------------------------------------------------ */

function submitApproval(dataDir, experiment, cfg = {}) {
  const rec = {
    id: nextId('appr'),
    experimentId: experiment.id,
    timestamp: new Date().toISOString(),
    title: `${experiment.type}: ${experiment.parameter} ${experiment.oldValue} → ${experiment.newValue}`,
    action: experiment.reason || '',
    priority: experiment.priority || 'MEDIUM',
    expectedLift: experiment.expectedLift || '',
    type: experiment.type,
    data: { parameter: experiment.parameter, oldValue: experiment.oldValue, newValue: experiment.newValue, evidence: experiment.evidence },
    status: 'pending',
    operatorNote: '',
    decidedAt: null,
    appliedAt: null
  };
  appendLine(file(dataDir, 'approvals.jsonl'), rec);
  return rec.id;
}

function loadApprovals(dataDir) {
  return readLines(file(dataDir, 'approvals.jsonl'));
}

function pendingApprovals(dataDir) {
  return loadApprovals(dataDir).filter((a) => a.status === 'pending')
    .sort((a, b) => {
      const pm = { HIGH: 3, MEDIUM: 2, LOW: 1 };
      return (pm[b.priority] || 0) - (pm[a.priority] || 0);
    });
}

function updateApproval(dataDir, experimentId, patch) {
  const path_ = file(dataDir, 'approvals.jsonl');
  const lines = readLines(path_);
  const updated = lines.map((a) => (a.experimentId === experimentId ? Object.assign({}, a, patch, { decidedAt: a.decidedAt || new Date().toISOString() }) : a));
  try {
    fs.writeFileSync(path_, updated.map((a) => JSON.stringify(a)).join('\n') + (updated.length ? '\n' : ''));
  } catch (_) { /* best effort */ }
}

/* ------------------------------------------------------------------ *
 * Backtest — candidate entry gates vs V1 over closed trades (in-sample).
 * ------------------------------------------------------------------ */

const DEFAULT_TOLERANCES = { winRatePts: 5, expectancyPct: 1.0, profitFactor: 0.2 };

function gateValueOf(trade, parameter) {
  if (parameter === 'minScore') return trade.entryScore;
  if (parameter === 'min1h' || parameter === 'max1h') return trade.change1hPct;
  if (parameter === 'min5m' || parameter === 'max5m') return trade.recovery5mPct;
  return null;
}

function passesGate(trade, parameter, value, v1 = gatesLib.V1) {
  const gates = Object.assign({}, v1, { [parameter]: value });
  return passesGates(trade, gates, v1);
}

/** Does a closed trade pass a FULL band set ({minScore,min1h,max1h,min5m,max5m})?
 *  Missing keys fall back to `v1` (default V1) — so partial band objects and
 *  single-param overrides share one code path. Pure. */
function passesGates(trade, gates, v1 = gatesLib.V1) {
  const g = Object.assign({}, v1, gates || {});
  const score = trade.entryScore == null ? v1.minScore : trade.entryScore;
  if (score < g.minScore) return false;
  if (trade.change1hPct != null && (trade.change1hPct <= g.min1h || trade.change1hPct > g.max1h)) return false;
  if (trade.recovery5mPct != null && (trade.recovery5mPct < g.min5m || trade.recovery5mPct > g.max5m)) return false;
  return true;
}

/** Validate a candidate global band set: every key known, every value inside
 *  the stricter-than-V1 BOUNDS. Returns { ok, reason, bands }. */
function validateBands(bands) {
  if (!bands || typeof bands !== 'object' || Array.isArray(bands)) {
    return { ok: false, reason: 'bands must be an object', bands: null };
  }
  const out = {};
  for (const param of gatesLib.GATE_PARAMS) {
    if (bands[param] == null) continue;
    const v = Number(bands[param]);
    const b = gatesLib.BOUNDS[param];
    if (!Number.isFinite(v)) return { ok: false, reason: `${param} is not a number`, bands: null };
    if (v < b.min - 1e-9 || v > b.max + 1e-9) {
      return { ok: false, reason: `${param}=${v} outside stricter-than-V1 bounds [${b.min}, ${b.max}]`, bands: null };
    }
    out[param] = v;
  }
  if (!Object.keys(out).length) return { ok: false, reason: 'bands object changes no gate parameter', bands: null };
  return { ok: true, reason: null, bands: out };
}

/** Resolve an experiment's old/new band sets. Single-param experiments
 *  (parameter/minScore...) map to a one-key override; band experiments carry
 *  `gates`/`oldGates` objects (parameter 'bands'). Returns { oldG, newG }. */
function experimentBands(experiment, v1 = gatesLib.V1) {
  if (experiment && experiment.gates && typeof experiment.gates === 'object') {
    const oldG = Object.assign({}, v1, experiment.oldGates || {});
    const newG = Object.assign({}, v1, experiment.gates || {});
    return { oldG, newG, multi: true };
  }
  const param = experiment ? experiment.parameter : null;
  if (param && gatesLib.GATE_PARAMS.includes(param)) {
    const oldG = Object.assign({}, v1, { [param]: experiment.oldValue });
    const newG = Object.assign({}, v1, { [param]: experiment.newValue });
    return { oldG, newG, multi: false };
  }
  return { oldG: Object.assign({}, v1), newG: Object.assign({}, v1), multi: false };
}

/** Statistics over closed trades (subset). */
function statsOf(trades) {
  const m = perf.computeMetrics(trades);
  return {
    n: m.n, wins: m.wins, losses: m.losses, winRate: m.winRate,
    expectancyPct: m.expectancyPct, expectancySol: m.expectancySol,
    profitFactor: m.profitFactor, totalPnlSol: m.totalPnlSol
  };
}

/* ------------------------------------------------------------------ *
 * Walk-forward — purged sequential out-of-sample validation.
 * ------------------------------------------------------------------ */

// Promotion-grade OOS bars (overridable via cfg for tests).
const DEFAULT_WF = {
  folds: 3,          // sequential exit-time folds
  minTrades: 30,     // total purged-OOS candidate sample required
  minFoldTrades: 5,  // a fold with fewer kept trades is skipped, not failed
  minOosPf: 1.2,     // every evaluated fold: profit factor strictly above this
  minOosExp: 0       // every evaluated fold: expectancy% strictly above this
};

function wfCfg(cfg = {}) {
  return {
    folds: Math.max(2, Math.min(5, Number.isFinite(Number(cfg.wfFolds)) ? Math.floor(Number(cfg.wfFolds)) : DEFAULT_WF.folds)),
    minTrades: Math.max(1, Number.isFinite(Number(cfg.wfMinTrades)) ? Math.floor(Number(cfg.wfMinTrades)) : DEFAULT_WF.minTrades),
    minFoldTrades: Math.max(1, Number.isFinite(Number(cfg.wfMinFoldTrades)) ? Math.floor(Number(cfg.wfMinFoldTrades)) : DEFAULT_WF.minFoldTrades),
    minOosPf: Number.isFinite(Number(cfg.wfMinOosPf)) ? Number(cfg.wfMinOosPf) : DEFAULT_WF.minOosPf,
    minOosExp: Number.isFinite(Number(cfg.wfMinOosExp)) ? Number(cfg.wfMinOosExp) : DEFAULT_WF.minOosExp
  };
}

/** Resolve how an experiment filters entries for walk-forward folds.
 *  Returns { kind: 'gates', oldG, newG } | { kind: 'arms', arms } | { kind: null }
 *  (null = no entry-filter effect: sizing/mode/maxBuys skip walk-forward). */
function wfFilterOf(experiment) {
  if (!experiment || typeof experiment !== 'object') return { kind: null };
  if (experiment.parameter === 'banditLive') {
    const arms = experiment.evidence && typeof experiment.evidence.arms === 'object' ? experiment.evidence.arms : null;
    if (!arms || !Object.keys(arms).length) return { kind: null, reason: 'banditLive needs evidence.arms snapshot' };
    return { kind: 'arms', arms };
  }
  if (experiment.parameter === 'bands') {
    const vb = validateBands(experiment.gates);
    if (!vb.ok) return { kind: null, reason: vb.reason };
    const oldB = validateBands(experiment.oldGates || {});
    return { kind: 'gates', oldG: Object.assign({}, gatesLib.V1, oldB.ok ? oldB.bands : {}), newG: Object.assign({}, gatesLib.V1, vb.bands) };
  }
  const param = experiment.parameter;
  if (param && gatesLib.GATE_PARAMS.includes(param)) {
    return {
      kind: 'gates',
      oldG: Object.assign({}, gatesLib.V1, { [param]: experiment.oldValue }),
      newG: Object.assign({}, gatesLib.V1, { [param]: experiment.newValue })
    };
  }
  return { kind: null };
}

/**
 * Purged walk-forward OOS evaluation for an entry-filter experiment.
 *
 * Closed trades are sorted by exitTs and split into K contiguous folds.
 * Each fold keeps only trades that BOTH exited in-fold AND entered in-fold:
 * boundary straddlers (entryTs < fold start, k>0) are purged so no outcome
 * is shared across slices. Folds with fewer than minFoldTrades kept trades
 * are skipped (thin evidence is reported, never passed silently).
 *
 * Pass bar: at least one evaluated fold AND every evaluated fold clears
 * PF > minOosPf and expectancy% > minOosExp AND total kept OOS n >= minTrades.
 * Pure + deterministic. Returns { passed, oosN, oosPurged, folds, reason }.
 */
function runWalkForward(experiment, closedTrades, cfg = {}) {
  const w = wfCfg(cfg);
  const filter = wfFilterOf(experiment);
  if (!filter || filter.kind == null) {
    return { skipped: true, passed: true, oosN: 0, oosPurged: 0, folds: [], reason: filter && filter.reason ? `walk-forward N/A: ${filter.reason}` : 'walk-forward N/A: no entry-filter effect' };
  }
  const list = (Array.isArray(closedTrades) ? closedTrades : [])
    .filter((t) => t && typeof t === 'object' && Number.isFinite(Number(t.exitTs)))
    .sort((a, b) => Number(a.exitTs) - Number(b.exitTs));
  if (list.length < 2) {
    return { skipped: false, passed: false, oosN: 0, oosPurged: 0, folds: [], reason: `walk-forward: only ${list.length} trade(s), need >= 2 to split folds` };
  }
  const folds = Math.min(w.folds, list.length);
  const per = Math.floor(list.length / folds);
  const slices = [];
  for (let k = 0; k < folds; k++) {
    const start = k * per;
    const end = k === folds - 1 ? list.length : start + per;
    if (end > start) slices.push(list.slice(start, end));
  }
  const out = [];
  let oosN = 0;
  let oosPurged = 0;
  for (let k = 0; k < slices.length; k++) {
    const slice = slices[k];
    const foldStart = Number(slice[0].exitTs);
    // Purge straddlers past the first fold: entered before this slice's time
    // window (outcome spans slices — drop for slice independence). Fold 0 has
    // no earlier slice, so nothing is purged there.
    const inFold = [];
    let purged = 0;
    for (const t of slice) {
      if (k > 0 && Number.isFinite(Number(t.entryTs)) && Number(t.entryTs) < foldStart) {
        purged += 1;
        continue;
      }
      inFold.push(t);
    }
    oosPurged += purged;
    // Baseline (old gates / V1) then candidate, mirroring the in-sample path.
    let candStats;
    let baseN = 0;
    if (filter.kind === 'arms') {
      const sim = gatesLib.banditBacktest(inFold, filter.arms);
      baseN = sim.baseline.n;
      candStats = sim.candidate;
    } else {
      const base = inFold.filter((t) => passesGates(t, filter.oldG));
      baseN = base.length;
      candStats = statsOf(base.filter((t) => passesGates(t, filter.newG)));
    }
    if (candStats.n < w.minFoldTrades) {
      out.push({ k, n: candStats.n, purged, baselineN: baseN, skipped: true, passed: null, winRate: null, expectancyPct: null, profitFactor: null });
      continue;
    }
    const ok = candStats.profitFactor > w.minOosPf && candStats.expectancyPct > w.minOosExp;
    oosN += candStats.n;
    out.push({ k, n: candStats.n, purged, baselineN: baseN, skipped: false, passed: ok, winRate: candStats.winRate, expectancyPct: candStats.expectancyPct, profitFactor: candStats.profitFactor });
  }
  const evaluated = out.filter((f) => !f.skipped);
  const detail = out.map((f) => (f.skipped ? `f${f.k}:skipped(n=${f.n})` : `f${f.k}:${f.passed ? 'PASS' : 'FAIL'}(n=${f.n},PF=${f.profitFactor},exp=${f.expectancyPct}%)`)).join(' ');
  if (!evaluated.length) {
    return { skipped: false, passed: false, oosN: 0, oosPurged, folds: out, reason: `walk-forward: no fold reached ${w.minFoldTrades} kept trades (${detail})` };
  }
  if (oosN < w.minTrades) {
    return { skipped: false, passed: false, oosN, oosPurged, folds: out, reason: `walk-forward: OOS n=${oosN} < ${w.minTrades} (${detail})` };
  }
  const bad = evaluated.filter((f) => !f.passed);
  if (bad.length) {
    return { skipped: false, passed: false, oosN, oosPurged, folds: out, reason: `walk-forward: fold(s) ${bad.map((f) => 'f' + f.k).join(',')} below OOS bars PF>${w.minOosPf}/exp>${w.minOosExp} (${detail})` };
  }
  return { skipped: false, passed: true, oosN, oosPurged, folds: out, reason: `walk-forward: ${evaluated.length}/${out.length} folds pass, OOS n=${oosN} (${detail})` };
}

/**
 * Run the backtest for a proposed gate change. Single-param experiments
 * override one gate; band experiments (`gates`/`oldGates` objects, parameter
 * 'bands') filter on the whole band set at once. Non-gate parameters (sizing,
 * mode, maxBuys) pass through with bounds validation only (they do not filter
 * entries, so win-rate backtests don't apply — documented in the evidence).
 *
 * Entry-filter experiments must ALSO clear the walk-forward OOS gate
 * (purged folds, strict PF/expectancy bars) before they can leave BACKTESTING:
 * in-sample edge that does not repeat out-of-sample never promotes.
 */
function runBacktest(dataDir, experiment, closedTrades, cfg = {}) {
  if (typeof experiment === 'string') experiment = getExperiment(dataDir, experiment);
  if (!experiment) return { state: 'REJECTED', reason: 'unknown experiment' };
  transition(dataDir, experiment.id, { state: 'BACKTESTING', backtestStartedAt: new Date().toISOString() });

  const minTrades = cfg.backtestMinTrades || 5;
  const tolerances = Object.assign({}, DEFAULT_TOLERANCES, cfg.tolerances || {});
  const result = { state: 'BACKTESTING', startedAt: new Date().toISOString() };

  if (experiment.parameter === 'bands') {
    const vb = validateBands(experiment.gates);
    if (!vb.ok) {
      transition(dataDir, experiment.id, { state: 'REJECTED', backtest: { passed: false, reason: vb.reason }, backtestedAt: new Date().toISOString() });
      return { state: 'REJECTED', passed: false, reason: vb.reason };
    }
  }

  if (experiment.parameter === 'banditLive') {
    // Bandit go-live: simulate the evidence arm map over history (V1 baseline
    // vs arm-filtered). Arms snapshot lives on experiment.evidence.arms.
    const arms = experiment.evidence && typeof experiment.evidence.arms === 'object' ? experiment.evidence.arms : null;
    if (!arms || !Object.keys(arms).length) {
      transition(dataDir, experiment.id, { state: 'REJECTED', backtest: { passed: false, reason: 'banditLive needs evidence.arms snapshot' }, backtestedAt: new Date().toISOString() });
      return { state: 'REJECTED', passed: false, reason: 'banditLive needs evidence.arms snapshot' };
    }
    const sim = gatesLib.banditBacktest(closedTrades, arms);
    result.baseline = sim.baseline;
    result.candidate = sim.candidate;
    result.passed =
      result.candidate.n >= minTrades &&
      result.candidate.winRate >= result.baseline.winRate - tolerances.winRatePts &&
      result.candidate.expectancyPct >= result.baseline.expectancyPct - tolerances.expectancyPct &&
      result.candidate.profitFactor >= result.baseline.profitFactor - tolerances.profitFactor;
    result.reason = result.passed
      ? `bandit backtest passed (n=${result.candidate.n}): WR ${result.candidate.winRate}% vs ${result.baseline.winRate}%, exp ${result.candidate.expectancyPct}% vs ${result.baseline.expectancyPct}%`
      : `bandit backtest failed (n=${result.candidate.n}): WR ${result.candidate.winRate}% vs ${result.baseline.winRate}%, exp ${result.candidate.expectancyPct}% vs ${result.baseline.expectancyPct}%`;
  } else {
    const { oldG, newG } = experimentBands(experiment);
    const baselineTrades = (Array.isArray(closedTrades) ? closedTrades : []).filter((t) => passesGates(t, oldG));
    result.baseline = statsOf(baselineTrades);

    if (experiment.parameter.startsWith('sizing') || ['mode', 'maxBuys'].includes(experiment.parameter)) {
      // Behavioral change — no entry-filter effect. Validate bounds only.
      const v = Number(experiment.newValue);
      const ok = Number.isFinite(v) && v >= 0 && (experiment.parameter.startsWith('sizing') ? v <= 1 : v <= (cfg.maxPositions || 3));
      result.passed = ok;
      result.candidate = result.baseline;
      result.reason = ok
        ? 'non-entry-gate parameter — bounds validated, no filter effect (conservative pass)'
        : 'invalid value for parameter bounds';
    } else {
      const candidateTrades = baselineTrades.filter((t) => passesGates(t, newG));
      result.candidate = statsOf(candidateTrades);
      result.passed =
        result.candidate.n >= minTrades &&
        result.candidate.winRate >= result.baseline.winRate - tolerances.winRatePts &&
        result.candidate.expectancyPct >= result.baseline.expectancyPct - tolerances.expectancyPct &&
        result.candidate.profitFactor >= result.baseline.profitFactor - tolerances.profitFactor;
      result.reason = result.passed
        ? `backtest passed (n=${result.candidate.n}): WR ${result.candidate.winRate}% vs ${result.baseline.winRate}%, exp ${result.candidate.expectancyPct}% vs ${result.baseline.expectancyPct}%`
        : `backtest failed (n=${result.candidate.n}): WR ${result.candidate.winRate}% vs ${result.baseline.winRate}%, exp ${result.candidate.expectancyPct}% vs ${result.baseline.expectancyPct}%`;
    }
  }

  // Walk-forward OOS gate (purged folds): in-sample edge must repeat
  // out-of-sample before anything can promote. Non-filter experiments skip.
  // Runs even when in-sample failed, so the record shows both halves.
  result.walkForward = runWalkForward(experiment, closedTrades, cfg);
  if (!result.walkForward.skipped) {
    const inSamplePassed = result.passed === true;
    result.passed = inSamplePassed && result.walkForward.passed;
    result.reason += ` | OOS: ${result.walkForward.reason}`;
  }

  const next = result.passed ? 'SHADOW' : 'REJECTED';
  transition(dataDir, experiment.id, { state: next, backtest: result, backtestedAt: new Date().toISOString() });
  return Object.assign(result, { state: next });
}

/* ------------------------------------------------------------------ *
 * Shadow — hypothetical replay of closed trades under the candidate policy.
 * ------------------------------------------------------------------ */

/**
 * Evaluate an experiment in SHADOW over the closed trades that exited after
 * the shadow started. Records every window trade to data/shadow-trades.jsonl
 * (wouldPass + outcome). Needs minShadowTrades trades to decide; otherwise it
 * keeps shadowing.
 */
function evaluateShadow(dataDir, experiment, closedTrades, cfg = {}) {
  if (typeof experiment === 'string') experiment = getExperiment(dataDir, experiment);
  if (!experiment) return { state: 'REJECTED', reason: 'unknown experiment' };
  const minTrades = cfg.shadowMinTrades || 5;
  const tolerances = Object.assign({}, DEFAULT_TOLERANCES, cfg.tolerances || {});
  const startedAt = (experiment.shadow && experiment.shadow.startedAt)
    ? Date.parse(experiment.shadow.startedAt)
    : Date.parse(experiment.backtestStartedAt || experiment.createdAt || 0) || 0;

  const window = (Array.isArray(closedTrades) ? closedTrades : []).filter((t) => t.exitTs >= startedAt);

  // Bandit go-live shadow: replay the evidence arm map over the window.
  if (experiment.parameter === 'banditLive') {
    const arms = experiment.evidence && typeof experiment.evidence.arms === 'object' ? experiment.evidence.arms : null;
    if (!arms || !Object.keys(arms).length) {
      rejectExperiment(dataDir, experiment.id, 'banditLive shadow needs evidence.arms snapshot');
      return { state: 'REJECTED', reason: 'banditLive shadow needs evidence.arms snapshot' };
    }
    for (const t of window) {
      const key = gatesLib.clusterKeyOf({ regime: t.regime, timeOfDay: t.timeOfDay, liqClass: t.liqClass });
      const arm = arms[key] && Number.isFinite(arms[key].arm) ? arms[key].arm : 60;
      const score = t.entryScore == null ? 60 : t.entryScore;
      appendLine(file(dataDir, 'shadow-trades.jsonl'), {
        experimentId: experiment.id,
        ts: new Date().toISOString(),
        mint: t.mint,
        symbol: t.symbol,
        entryTs: t.entryTs,
        exitTs: t.exitTs,
        realizedPnlSol: t.realizedPnlSol,
        realizedPnlPct: t.realizedPnlPct,
        wouldPass: score >= arm,
        clusterKey: key,
        arm,
        entryScore: t.entryScore
      });
    }
    if (window.length < minTrades) {
      transition(dataDir, experiment.id, { shadow: { startedAt: experiment.shadow && experiment.shadow.startedAt, windowTrades: window.length, pending: true } });
      return { state: 'SHADOW', pending: true, windowTrades: window.length, needed: minTrades };
    }
    const sim = gatesLib.banditBacktest(window, arms);
    const passed =
      sim.candidate.n >= minTrades &&
      sim.candidate.winRate >= sim.baseline.winRate - tolerances.winRatePts &&
      sim.candidate.expectancyPct >= sim.baseline.expectancyPct - tolerances.expectancyPct &&
      sim.candidate.profitFactor >= sim.baseline.profitFactor - tolerances.profitFactor;
    const evalResult = { state: 'SHADOW', evaluatedAt: new Date().toISOString(), windowTrades: window.length, baseline: sim.baseline, candidate: sim.candidate, passed };
    transition(dataDir, experiment.id, { shadow: evalResult });
    if (!passed) {
      rejectExperiment(dataDir, experiment.id, `bandit shadow validation failed (WR ${sim.candidate.winRate}% vs ${sim.baseline.winRate}%)`);
      return Object.assign({}, evalResult, { state: 'REJECTED' });
    }
    const autoApply = cfg.autoApply === true;
    if (autoApply) {
      return applyExperiment(dataDir, experiment.id, { via: 'autoApply', note: 'bandit shadow validation passed and adaptive.autoApply enabled' });
    }
    transition(dataDir, experiment.id, { state: 'PENDING_APPROVAL', approvalRequestedAt: new Date().toISOString() });
    return Object.assign({}, evalResult, { state: 'PENDING_APPROVAL' });
  }

  // Append the hypothetical replay rows (audit trail).
  const { oldG: shadowOldG, newG: shadowNewG } = experimentBands(experiment);
  for (const t of window) {
    appendLine(file(dataDir, 'shadow-trades.jsonl'), {
      experimentId: experiment.id,
      ts: new Date().toISOString(),
      mint: t.mint,
      symbol: t.symbol,
      entryTs: t.entryTs,
      exitTs: t.exitTs,
      realizedPnlSol: t.realizedPnlSol,
      realizedPnlPct: t.realizedPnlPct,
      wouldPass: passesGates(t, shadowNewG),
      entryScore: t.entryScore,
      change1hPct: t.change1hPct,
      recovery5mPct: t.recovery5mPct
    });
  }

  if (window.length < minTrades) {
    transition(dataDir, experiment.id, { shadow: { startedAt: experiment.shadow && experiment.shadow.startedAt, windowTrades: window.length, pending: true } });
    return { state: 'SHADOW', pending: true, windowTrades: window.length, needed: minTrades };
  }

  const baselineTrades = window.filter((t) => passesGates(t, shadowOldG));
  const candidateTrades = baselineTrades.filter((t) => passesGates(t, shadowNewG));
  const baseline = statsOf(baselineTrades);
  const candidate = statsOf(candidateTrades);

  const passed =
    candidate.n >= minTrades &&
    candidate.winRate >= baseline.winRate - tolerances.winRatePts &&
    candidate.expectancyPct >= baseline.expectancyPct - tolerances.expectancyPct &&
    candidate.profitFactor >= baseline.profitFactor - tolerances.profitFactor;

  const evalResult = {
    state: 'SHADOW',
    evaluatedAt: new Date().toISOString(),
    windowTrades: window.length,
    baseline,
    candidate,
    passed
  };
  transition(dataDir, experiment.id, { shadow: evalResult });

  if (!passed) {
    rejectExperiment(dataDir, experiment.id, `shadow validation failed (WR ${candidate.winRate}% vs ${baseline.winRate}%)`);
    return Object.assign({}, evalResult, { state: 'REJECTED' });
  }

  // Validation passed → next step depends on autoApply.
  const autoApply = cfg.autoApply === true;
  if (autoApply) {
    return applyExperiment(dataDir, experiment.id, { via: 'autoApply', note: 'shadow validation passed and adaptive.autoApply enabled' });
  }
  transition(dataDir, experiment.id, { state: 'PENDING_APPROVAL', approvalRequestedAt: new Date().toISOString() });
  return Object.assign({}, evalResult, { state: 'PENDING_APPROVAL' });
}

/* ------------------------------------------------------------------ *
 * Create / approve / reject / apply / rollback.
 * ------------------------------------------------------------------ */

function createExperiment(dataDir, opts = {}) {
  const parameter = String(opts.parameter || '');
  const oldValue = opts.oldValue;
  const newValue = opts.newValue;
  const id = nextId('exp');
  const experiment = {
    id,
    type: opts.type || 'policy',
    parameter,
    oldValue,
    newValue,
    // Band experiments (parameter 'bands') carry full old/new gate sets;
    // single-param experiments use oldValue/newValue only.
    gates: (opts.gates && typeof opts.gates === 'object') ? Object.assign({}, opts.gates) : undefined,
    oldGates: (opts.oldGates && typeof opts.oldGates === 'object') ? Object.assign({}, opts.oldGates) : undefined,
    reason: opts.reason || '',
    evidence: opts.evidence || {},
    priority: opts.priority || 'MEDIUM',
    expectedLift: opts.expectedLift || '',
    state: 'PROPOSED',
    createdAt: new Date().toISOString(),
    parentVersion: opts.parentVersion || null,
    autoApply: opts.autoApply === true
  };
  appendLine(file(dataDir, 'experiments.jsonl'), Object.assign({}, experiment, { experimentId: id, event: 'created' }));
  const approvalId = submitApproval(dataDir, experiment, opts.cfg || {});
  transition(dataDir, id, { approvalId });
  return Object.assign({}, experiment, { approvalId });
}

function approveExperiment(dataDir, id, { note = '', operator = 'operator' } = {}) {
  const exp = getExperiment(dataDir, id);
  if (!exp) return null;
  if (exp.state !== 'PENDING_APPROVAL') return { error: `cannot approve experiment in state ${exp.state}` };
  return applyExperiment(dataDir, id, { via: 'operator', note, operator });
}

function rejectExperiment(dataDir, id, note = '') {
  const exp = getExperiment(dataDir, id);
  if (!exp) return null;
  transition(dataDir, id, { state: 'REJECTED', rejectedAt: new Date().toISOString(), rejectionNote: note });
  updateApproval(dataDir, id, { status: 'rejected', operatorNote: note });
  return getExperiment(dataDir, id);
}

function applyExperiment(dataDir, id, { via = 'autoApply', note = '', operator = null } = {}) {
  const exp = getExperiment(dataDir, id);
  if (!exp) return null;
  if (!['PENDING_APPROVAL', 'SHADOW'].includes(exp.state)) {
    return { error: `cannot apply experiment in state ${exp.state}` };
  }

  const versions = loadVersions(dataDir);
  const cur = currentVersion(versions);
  let targetVersion = cur.id;
  let revert = null;

  if (exp.type === 'gate-update') {
    // Promote the learned gate into learned-gates.json for its cluster.
    const gates = gatesLib.loadGates(dataDir);
    if (!gates.gates[exp.evidence.clusterKey]) gates.gates[exp.evidence.clusterKey] = {};
    gates.gates[exp.evidence.clusterKey][exp.parameter] = {
      oldValue: exp.oldValue,
      newValue: exp.newValue,
      confidence: exp.evidence.confidence,
      sample: exp.evidence.sample,
      reasoning: exp.reason,
      promotedAt: new Date().toISOString()
    };
    gatesLib.saveGates(dataDir, gates.gates);
    revert = { kind: 'gate', clusterKey: exp.evidence.clusterKey, parameter: exp.parameter };
  } else if (exp.type === 'baseline') {
    // Baseline change → new strategy version with parent pointer.
    const id2 = nextVersionId(versions);
    const d = Object.assign({}, cur.deltas || {});
    if (exp.parameter === 'bands') {
      // Global entry-band tightening (multi-param): validated stricter-than-V1
      // object, stored as bandsBase (never looser than V1, never outside
      // BOUNDS — validateBands enforces both).
      const vb = validateBands(exp.gates);
      if (!vb.ok) return { error: `invalid bands: ${vb.reason}` };
      d.bandsBase = Object.assign({}, (d.bandsBase && typeof d.bandsBase === 'object') ? d.bandsBase : {}, vb.bands);
    } else {
      d[exp.parameter] = Number(exp.newValue);
    }
    versions.versions.push({
      id: id2,
      parentId: cur.id,
      experimentId: exp.id,
      deltas: d,
      createdAt: new Date().toISOString(),
      status: 'active'
    });
    versions.current = id2;
    saveVersions(dataDir, versions);
    targetVersion = id2;
    revert = { kind: 'baseline', parameter: exp.parameter, parentId: cur.id };
  } else {
    return { error: `unsupported experiment type ${exp.type}` };
  }

  transition(dataDir, id, {
    state: 'PROMOTED',
    promotedAt: new Date().toISOString(),
    promotedVia: via,
    targetVersion,
    revert
  });
  updateApproval(dataDir, id, { status: 'applied', operatorNote: note + (operator ? ` (by ${operator})` : ''), appliedAt: new Date().toISOString() });
  // Record the change for later grading (reflection-engine reads this log).
  // Lazy require — strategy-experiments and reflection-engine reference each
  // other at runtime only, so no circular-load problem.
  try {
    require('./reflection-engine.js').logPolicyChange(dataDir, {
      policyChangeId: exp.id,
      strategyVersion: targetVersion,
      parameter: exp.parameter,
      oldValue: exp.oldValue,
      newValue: exp.newValue,
      reason: exp.reason,
      evidence: exp.evidence
    });
  } catch (_) { /* best effort */ }
  return getExperiment(dataDir, id);
}

/**
 * Roll back a promoted experiment that performed materially worse.
 * Restores the parent version (baseline changes) or removes the gate
 * (gate updates). Never touches safety controls.
 */
function rollbackExperiment(dataDir, id, { grade = 'NEGATIVE', note = '' } = {}) {
  const exp = getExperiment(dataDir, id);
  if (!exp) return null;
  if (exp.state !== 'PROMOTED') return { error: `cannot roll back experiment in state ${exp.state}` };

  const versions = loadVersions(dataDir);
  const cur = currentVersion(versions);
  const revert = exp.revert || {};

  if (revert.kind === 'gate' && revert.clusterKey && revert.parameter) {
    const gates = gatesLib.loadGates(dataDir);
    if (gates.gates[revert.clusterKey]) {
      delete gates.gates[revert.clusterKey][revert.parameter];
      if (!Object.keys(gates.gates[revert.clusterKey]).length) delete gates.gates[revert.clusterKey];
      gatesLib.saveGates(dataDir, gates.gates);
    }
  } else if (revert.kind === 'baseline' && revert.parentId) {
    const parent = (versions.versions || []).find((v) => v.id === revert.parentId);
    if (parent) {
      versions.current = parent.id;
      saveVersions(dataDir, versions);
    }
  }

  transition(dataDir, id, { state: 'ROLLED_BACK', rolledBackAt: new Date().toISOString(), rollbackGrade: grade, rollbackNote: note });
  updateApproval(dataDir, id, { status: 'rolled_back', operatorNote: note });
  return getExperiment(dataDir, id);
}

/* ------------------------------------------------------------------ *
 * Summary for the dashboard.
 * ------------------------------------------------------------------ */

function summary(dataDir, cfg = {}) {
  const experiments = loadExperiments(dataDir);
  const versions = loadVersions(dataDir);
  const approvals = loadApprovals(dataDir);
  const baseline = effectiveBaseline(versions, cfg);
  const gates = gatesLib.gateSummary(gatesLib.loadGates(dataDir));
  return {
    versions: { current: versions.current, list: versions.versions },
    baseline,
    experiments: {
      total: experiments.length,
      byState: STATES.reduce((acc, s) => { acc[s] = experiments.filter((e) => e.state === s).length; return acc; }, {}),
      recent: experiments.slice(-8).map((e) => ({
        id: e.id,
        type: e.type,
        parameter: e.parameter,
        oldValue: e.oldValue,
        newValue: e.newValue,
        state: e.state,
        createdAt: e.createdAt,
        reason: e.reason
      }))
    },
    approvals: {
      pending: approvals.filter((a) => a.status === 'pending').length,
      approved: approvals.filter((a) => a.status === 'approved' || a.status === 'applied').length,
      rejected: approvals.filter((a) => a.status === 'rejected').length,
      rolledBack: approvals.filter((a) => a.status === 'rolled_back').length,
      pendingList: pendingApprovals(dataDir)
    },
    gates: {
      clusters: gates.clusters,
      entries: gates.entries,
      updatedAt: gates.updatedAt,
      list: gates.clustersList
    },
    rollback: {
      rolledBackExperiments: experiments.filter((e) => e.state === 'ROLLED_BACK').length
    }
  };
}

module.exports = {
  STATES,
  DEFAULT_TOLERANCES,
  DEFAULT_WF,
  createExperiment,
  getExperiment,
  loadExperiments,
  runBacktest,
  runWalkForward,
  evaluateShadow,
  approveExperiment,
  rejectExperiment,
  applyExperiment,
  rollbackExperiment,
  loadVersions,
  saveVersions,
  currentVersion,
  nextVersionId,
  effectiveBaseline,
  loadApprovals,
  pendingApprovals,
  submitApproval,
  summary,
  passesGate,
  passesGates,
  validateBands,
  experimentBands,
  statsOf
};