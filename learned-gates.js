#!/usr/bin/env node
/**
 * learned-gates.js — learn + apply adaptive entry thresholds (Circuit Tier 1
 * equivalent, adapted to this paper strategy).
 *
 * Upstream learns a buyRatio threshold per `pattern|timeOfDay|liquidityClass`
 * cluster (verified in lib/analysis/gate-learner.js + learned-gates.js). Our
 * V1 strategy gates on score / 1h change / 5m recovery instead, so we learn
 * the SAME MECHANISM over the thresholds V1 actually uses:
 *
 *   cluster  = regime | timeOfDay | liquidityClass
 *   gates    = minScore, min1h, max1h, min5m, max5m
 *
 * Learned gates can only be STRICTER than V1 (never looser):
 *   minScore ∈ [60, 90]      (V1 floor is preserved — score >= 60 always)
 *   min1h    ∈ [-35, -15]    (raise the 1h lower bound)
 *   max1h    ∈ [15, 5]       (lower the 1h upper bound)
 *   min5m    ∈ [0.25, 2]     (raise the 5m recovery floor)
 *   max5m    ∈ [8, 3]        (lower the 5m recovery ceiling)
 *
 * Minimum sample protection is mandatory: a cluster below MIN_SAMPLES learns
 * nothing and the scanner falls back to V1 (INSUFFICIENT_DATA).
 *
 * Persisted to data/learned-gates.json; only PROMOTED gates live in the file
 * (candidates travel through the strategy-experiments approval workflow).
 */

'use strict';

const fs = require('fs');
const path = require('path');

/* V1 baseline (must match agentd.js — do not change). */
const V1 = {
  minScore: 60,
  min1h: -35,
  max1h: 15,
  min5m: 0.25,
  max5m: 8
};

const GATE_PARAMS = ['minScore', 'min1h', 'max1h', 'min5m', 'max5m'];

/* Stricter-than-V1 bounds for each gate parameter. */
const BOUNDS = {
  minScore: { min: 60, max: 90, step: 5 },
  min1h: { min: -35, max: -15, step: 5 },   // higher = stricter
  max1h: { min: 5, max: 15, step: 5 },      // lower = stricter
  min5m: { min: 0.25, max: 2, step: 0.25 }, // higher = stricter
  max5m: { min: 3, max: 8, step: 1 }        // lower = stricter
};

const MIN_SAMPLES = 8;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.85;

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/** Cluster key: `regime|timeOfDay|liqClass` (regime defaults to 'unknown'). */
function clusterKeyOf({ regime, timeOfDay, liqClass }) {
  return [regime || 'unknown', timeOfDay || 'unknown', liqClass || 'medium'].join('|');
}

/** Does a closed trade pass V1 + a candidate gate value for one parameter? */
function passesWith(trade, param, value) {
  const gates = Object.assign({}, V1, { [param]: value });
  const score = trade.entryScore == null ? V1.minScore : trade.entryScore;
  if (score < gates.minScore) return false;
  const c1h = trade.change1hPct;
  if (c1h != null && (c1h <= gates.min1h || c1h > gates.max1h)) return false;
  const c5m = trade.recovery5mPct;
  if (c5m != null && (c5m < gates.min5m || c5m > gates.max5m)) return false;
  return true;
}

/** Score of a filtered subset: wins − losses×1.5 (same objective as upstream). */
function scoreSubset(trades) {
  let wins = 0, losses = 0;
  for (const t of trades) {
    if (t.realizedPnlSol > 0) wins += 1;
    else losses += 1;
  }
  return { wins, losses, score: wins - losses * 1.5 };
}

/**
 * Learn candidate gate updates per cluster from real closed trades.
 * Returns { proposals, perCluster } where proposals is an array of
 *   { clusterKey, parameter, oldValue, newValue, confidence, sample,
 *     wins, losses, reasoning }
 * Only clusters with sample >= minSamples produce proposals; a parameter is
 * proposed only when a stricter value strictly beats the V1 baseline score
 * for that cluster. Confidence rises with sample size (0.5 + 0.05×n, capped
 * 0.95) — matching upstream's n-based confidence.
 */
function learnGates(trades, opts = {}) {
  const minSamples = opts.minSamples || MIN_SAMPLES;
  const list = Array.isArray(trades) ? trades : [];
  const byCluster = new Map();
  for (const t of list) {
    const key = clusterKeyOf(t);
    if (!byCluster.has(key)) byCluster.set(key, []);
    byCluster.get(key).push(t);
  }

  const proposals = [];
  const perCluster = {};

  for (const [clusterKey, cluster] of byCluster) {
    if (cluster.length < minSamples) {
      perCluster[clusterKey] = {
        n: cluster.length,
        status: 'INSUFFICIENT_DATA',
        reason: `only ${cluster.length}/${minSamples} trades — V1 applies`
      };
      continue;
    }
    const baseline = scoreSubset(cluster);
    const entries = [];
    for (const param of GATE_PARAMS) {
      const b = BOUNDS[param];
      let bestValue = null;
      let best = null;
      for (let v = b.min; v <= b.max + 1e-9; v = Math.round((v + b.step) * 1000) / 1000) {
        const subset = cluster.filter((t) => passesWith(t, param, v));
        if (subset.length < Math.max(3, Math.round(minSamples * 0.3))) continue; // keep meaningful sample
        const s = scoreSubset(subset);
        if (!best || s.score > best.score) { best = s; bestValue = v; }
      }
      if (best && bestValue != null && best.score > baseline.score + 1e-9 && bestValue !== V1[param]) {
        entries.push({
          clusterKey,
          parameter: param,
          oldValue: V1[param],
          newValue: bestValue,
          confidence: Math.min(0.95, 0.5 + cluster.length * 0.05),
          sample: cluster.length,
          wins: best.wins,
          losses: best.losses,
          reasoning: `cluster ${clusterKey}: ${best.wins}W/${best.losses}L at ${param}=${bestValue} (vs V1 ${V1[param]}, baseline ${baseline.wins}W/${baseline.losses}L)`
        });
      }
    }
    perCluster[clusterKey] = {
      n: cluster.length,
      status: 'LEARNED',
      baseline: { wins: baseline.wins, losses: baseline.losses, score: Math.round(baseline.score * 10) / 10 },
      proposals: entries
    };
    proposals.push(...entries);
  }

  return { proposals, perCluster };
}

/* ------------------------------------------------------------------ *
 * Persistence (data/learned-gates.json) — only PROMOTED gates.
 * ------------------------------------------------------------------ */

function gatesFile(dataDir) {
  return path.join(dataDir, 'learned-gates.json');
}

function loadGates(dataDir) {
  try {
    const file = gatesFile(dataDir);
    if (fs.existsSync(file)) {
      const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (obj && obj.gates && typeof obj.gates === 'object') return obj;
    }
  } catch (_) { /* unreadable → none */ }
  return { gates: {}, updatedAt: null };
}

function saveGates(dataDir, gates) {
  const out = { gates: gates || {}, updatedAt: new Date().toISOString() };
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const file = gatesFile(dataDir);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch (_) { /* best effort */ }
  return out;
}

/**
 * Effective entry gates for a candidate: base (default V1 — or the promoted
 * global bandsBase) tightened by any PROMOTED learned gate whose confidence
 * clears the threshold. Never looser than the base.
 * @returns {{ minScore, min1h, max1h, min5m, max5m, applied: string[] }}
 */
function effectiveGates(gates, clusterKey, cfg = {}, base) {
  const threshold = cfg.gateConfidenceThreshold != null ? cfg.gateConfidenceThreshold : DEFAULT_CONFIDENCE_THRESHOLD;
  const b = Object.assign({}, V1, base || {});
  const eff = Object.assign({}, b);
  const applied = [];
  const cluster = (gates && gates.gates && gates.gates[clusterKey]) || {};
  for (const param of GATE_PARAMS) {
    const g = cluster[param];
    if (!g) continue;
    const conf = Number(g.confidence);
    if (!Number.isFinite(conf) || conf < threshold) continue;
    const v = Number(g.newValue);
    if (!Number.isFinite(v)) continue;
    const bounds = BOUNDS[param];
    const clamped = clamp(v, bounds.min, bounds.max);
    // Stricter-only relative to the BASE (V1 by default): minScore/min1h/
    // min5m raise, max1h/max5m lower. A gate looser than base never applies.
    const baseV = Number.isFinite(b[param]) ? b[param] : V1[param];
    const stricter = param === 'max1h' || param === 'max5m' ? clamped <= baseV : clamped >= baseV;
    if (!stricter) continue;
    eff[param] = clamped;
    applied.push(`${param}=${clamped} (conf ${conf.toFixed(2)}, n=${g.sample})`);
  }
  return { gates: eff, applied };
}

/** Dashboard summary of promoted gates. */
function gateSummary(gates) {
  const g = (gates && gates.gates) || {};
  const out = { clusters: 0, entries: 0, updatedAt: gates && gates.updatedAt || null, clustersList: [] };
  for (const [key, entry] of Object.entries(g)) {
    const params = Object.keys(entry || {}).filter((p) => GATE_PARAMS.includes(p));
    if (!params.length) continue;
    out.clusters += 1;
    out.entries += params.length;
    out.clustersList.push({ clusterKey: key, gates: params.map((p) => ({ parameter: p, value: entry[p].newValue, confidence: entry[p].confidence, sample: entry[p].sample })) });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Thompson-sampling bandit for per-cluster minScore (replaces fixed/global
 * minScore with data-driven per-regime|time|liq thresholds).
 *
 * Arms = minScore candidates [60, 65, 70, 75] (within BOUNDS; 60 = V1).
 * Reward = trade win (Beta-Bernoulli). Each cluster keeps Beta(1+w, 1+l)
 * posteriors per arm; the daily arm is argmax over posterior SAMPLES
 * (exploration with uncertainty, exploitation with evidence).
 *
 * Determinism: Math.random() is FORBIDDEN on signal paths — sampling uses a
 * seeded mulberry32 (seed = day + clusterKey), so selection is exactly
 * reproducible given (day, posteriors) and idempotent to recompute. Shapes
 * stay integer (counts + 1), so Beta draws reduce to exact
 * sum-of-exponentials Gamma sampling (no approximations).
 *
 * Attribution is EXACT, not counterfactual: executePaperBuy stamps the
 * selected arm (entryMinScore) on the BUY row; closes credit that arm only.
 * Rows without an arm predate the bandit and are skipped.
 *
 * Cold start: clusters below BANDIT_MIN_SAMPLES outcomes hold arm 60 (V1 —
 * never restrict on evidence-free uncertainty).
 *
 * Pipeline: arm influence goes live via the standard workflow (baseline
 * experiment parameter 'banditLive' → backtest → shadow → approve →
 * PROMOTED/rollback). Posteriors themselves are statistics (rebuilt from
 * the ledger, no approval needed to LEARN). banditBacktest() simulates a
 * given arm map over history for that validation.
 * ------------------------------------------------------------------ */

const BANDIT_ARMS = [60, 65, 70, 75];
const BANDIT_MIN_SAMPLES = 8;
const BANDIT_FILE = 'bandit-state.json';

/** FNV-1a string hash → uint32 (deterministic seed material). */
function hashStr32(s) {
  let h = 2166136261;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 — small deterministic PRNG (seeded; never Math.random). */
function mulberry32(seed) {
  let a = (Number(seed) || 0) >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Gamma(shape k: positive integer) via sum of exponentials — exact. */
function sampleGammaInt(k, rng) {
  let s = 0;
  for (let i = 0; i < k; i++) {
    let u = rng();
    if (!(u > 0)) u = Number.MIN_VALUE; // log(0) guard; rng never emits exactly 0 in practice
    s += -Math.log(u);
  }
  return s;
}

/** Beta(a, b) draw for positive-integer shapes via two Gammas. */
function sampleBetaInt(a, b, rng) {
  const x = sampleGammaInt(Math.max(1, Math.round(a)), rng);
  const y = sampleGammaInt(Math.max(1, Math.round(b)), rng);
  return x / (x + y);
}

function blankBanditState() {
  return { version: 1, updatedAt: null, lastSelectionDay: null, clusters: {}, arms: {} };
}

function banditFile(dataDir) {
  return path.join(dataDir, BANDIT_FILE);
}

function loadBanditState(dataDir) {
  try {
    const f = banditFile(dataDir);
    if (fs.existsSync(f)) {
      const obj = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (obj && typeof obj === 'object' && obj.clusters && typeof obj.clusters === 'object') {
        return Object.assign(blankBanditState(), obj);
      }
    }
  } catch (_) { /* unreadable → blank */ }
  return blankBanditState();
}

function saveBanditState(dataDir, state) {
  const out = Object.assign(blankBanditState(), state || {}, { updatedAt: new Date().toISOString() });
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const f = banditFile(dataDir);
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
    fs.renameSync(tmp, f);
  } catch (_) { /* best effort */ }
  return out;
}

function banditCounts(clusterEntry, arm) {
  const e = (clusterEntry && clusterEntry[arm]) || {};
  return { w: Number.isFinite(e.w) && e.w >= 0 ? Math.floor(e.w) : 0, l: Number.isFinite(e.l) && e.l >= 0 ? Math.floor(e.l) : 0 };
}

function banditClusterN(clusterEntry) {
  let n = 0;
  for (const arm of BANDIT_ARMS) {
    const c = banditCounts(clusterEntry, arm);
    n += c.w + c.l;
  }
  return n;
}

/** Thompson-select one arm for a cluster: argmax over Beta(1+w, 1+l)
 *  samples with a deterministic day+cluster seed. Ties → lower minScore
 *  (less restrictive). Returns { arm, n, sampled }. */
function banditSelectArm(clusterEntry, dayStr, clusterKey, opts = {}) {
  const arms = Array.isArray(opts.arms) && opts.arms.length ? opts.arms : BANDIT_ARMS;
  const rng = mulberry32(hashStr32(String(dayStr) + '|' + String(clusterKey)));
  let best = null;
  for (const arm of arms) {
    const c = banditCounts(clusterEntry, arm);
    const theta = sampleBetaInt(1 + c.w, 1 + c.l, rng);
    if (!best || theta > best.theta + 1e-12 || (Math.abs(theta - best.theta) <= 1e-12 && arm < best.arm)) {
      best = { arm, theta, w: c.w, l: c.l };
    }
  }
  return { arm: best.arm, n: banditCounts(clusterEntry, best.arm).w + banditCounts(clusterEntry, best.arm).l, clusterN: banditClusterN(clusterEntry), sampled: round2(best.theta) };
}

/** Select arms for many clusters at once (one deterministic seed each).
 *  Returns { key: { arm, n, clusterN, sampled } }. */
function selectBanditArms(banditState, clusterKeys, dayStr, opts = {}) {
  const out = {};
  const clusters = (banditState && banditState.clusters) || {};
  for (const key of (Array.isArray(clusterKeys) ? clusterKeys : [])) {
    out[key] = banditSelectArm(clusters[key], dayStr, key, opts);
  }
  return out;
}

/** Rebuild posteriors from scratch over closed trades (idempotent —
 *  no watermark bookkeeping, restart-safe). Credits the ENTRY-active arm
 *  (trade.entryMinScore) in the ENTRY cluster (regime|timeOfDay|liqClass);
 *  rows without a known arm are skipped. Returns the cluster map. */
function banditUpdateFromTrades(closedTrades, opts = {}) {
  const arms = Array.isArray(opts.arms) && opts.arms.length ? opts.arms : BANDIT_ARMS;
  const clusters = {};
  for (const t of (Array.isArray(closedTrades) ? closedTrades : [])) {
    if (!t || typeof t !== 'object') continue;
    const arm = Number(t.entryMinScore);
    if (!Number.isFinite(arm) || arms.indexOf(arm) < 0) continue;
    const key = clusterKeyOf({ regime: t.regime, timeOfDay: t.timeOfDay, liqClass: t.liqClass });
    if (!clusters[key]) clusters[key] = {};
    if (!clusters[key][arm]) clusters[key][arm] = { w: 0, l: 0 };
    if (t.realizedPnlSol > 0) clusters[key][arm].w += 1;
    else clusters[key][arm].l += 1;
  }
  return clusters;
}

/** Effective arm for gating: selected arm when the cluster has enough
 *  outcomes, else V1 (60) — never restrict on thin evidence. */
function banditEffectiveArm(selection, opts = {}) {
  const minSamples = opts.minSamples != null ? opts.minSamples : BANDIT_MIN_SAMPLES;
  if (!selection || !Number.isFinite(selection.arm)) return 60;
  if ((selection.clusterN || 0) < minSamples) return 60;
  return selection.arm;
}

/** Simulate an arm map over history: keep trades passing V1 AND scoring at
 *  or above their cluster's arm (missing cluster → arm 60 = V1).
 *  Returns { baseline, candidate } metric pairs for the workflow. */
function banditBacktest(closedTrades, armsByCluster, v1) {
  const perf = require('./performance-analyzer.js');
  const base = Object.assign({}, V1, v1 || {});
  const passesAll = (t, gates) => {
    const score = t.entryScore == null ? base.minScore : t.entryScore;
    if (score < gates.minScore) return false;
    if (t.change1hPct != null && (t.change1hPct <= gates.min1h || t.change1hPct > gates.max1h)) return false;
    if (t.recovery5mPct != null && (t.recovery5mPct < gates.min5m || t.recovery5mPct > gates.max5m)) return false;
    return true;
  };
  const list = (Array.isArray(closedTrades) ? closedTrades : []).filter((t) => t && typeof t === 'object');
  const armOf = (t) => {
    const key = clusterKeyOf({ regime: t.regime, timeOfDay: t.timeOfDay, liqClass: t.liqClass });
    const a = armsByCluster ? armsByCluster[key] : null;
    const arm = (a && Number.isFinite(a.arm)) ? a.arm : 60;
    return { key, arm: BANDIT_ARMS.indexOf(arm) >= 0 ? arm : 60 };
  };
  const baseKeep = list.filter((t) => passesAll(t, base));
  const candKeep = baseKeep.filter((t) => {
    const score = t.entryScore == null ? base.minScore : t.entryScore;
    return score >= armOf(t).arm;
  });
  const statsOf = (ts) => {
    const m = perf.computeMetrics(ts);
    return { n: m.n, wins: m.wins, losses: m.losses, winRate: m.winRate, expectancyPct: m.expectancyPct, expectancySol: m.expectancySol, profitFactor: m.profitFactor, totalPnlSol: m.totalPnlSol };
  };
  return { baseline: statsOf(baseKeep), candidate: statsOf(candKeep) };
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/* ------------------------------------------------------------------ *
 * Calibrated P(trade win) — Laplace-smoothed Naive Bayes over entry
 * features (global pool, no cluster split, so there is no n<8 cliff:
 * with tiny samples every posterior shrinks toward the smoothed base
 * rate instead of reporting INSUFFICIENT_DATA).
 *
 * Features (all binned; missing → 'unknown' bucket, never dropped):
 *   score band | 1h bucket | 5m bucket | liq class | vol bucket | rsi bucket
 *   | spread bucket (reserved slot — Solana AMMs expose no order-book
 *   spread, so this is 'unknown' until a spread feed exists; pass-through
 *   when finite).
 *
 * Thresholds are tuned for PROFIT FACTOR (not win rate) by sweeping the
 * in-sample keep-set (documented optimistic; guards below keep it honest).
 * Pure + deterministic. Retrained per scan from the ledger (O(n), no state
 * file, restart-safe by construction).
 * ------------------------------------------------------------------ */

const WINPROB_ALPHA = 1;            // Laplace smoothing strength
const WINPROB_MIN_TRAIN = 10;       // below this: model null → gate fails open
const WINPROB_DEFAULT_THRESHOLD = 0.5;

function bucketScore(v) {
  if (!Number.isFinite(v)) return 'unknown';
  if (v >= 75) return '75+';
  if (v >= 65) return '65-74';
  return '60-64';
}

function bucket1h(v) {
  if (!Number.isFinite(v)) return 'unknown';
  if (v <= -25) return 'deep';
  if (v <= 0) return 'dip';
  if (v <= 8) return 'flat';
  return 'pump';
}

function bucket5m(v) {
  if (!Number.isFinite(v)) return 'unknown';
  if (v < 1) return 'low';
  if (v <= 3) return 'mid';
  if (v <= 5) return 'high';
  return 'late';
}

function bucketVol(v) {
  if (!Number.isFinite(v)) return 'unknown';
  if (v < 100000) return 'thin';
  if (v <= 1000000) return 'mid';
  return 'deep';
}

function bucketRsi(v) {
  if (!Number.isFinite(v)) return 'unknown';
  if (v < 30) return 'os';
  if (v < 50) return 'soft';
  if (v < 70) return 'firm';
  return 'hot';
}

function bucketSpread(v) {
  if (!Number.isFinite(v)) return 'unknown';
  if (v <= 0.5) return 'tight';
  if (v <= 2) return 'normal';
  return 'wide';
}

// Feature extractors: [name, ofTrade, ofCandidate]. liqClass reuses the
// shared classifier so trades and candidates bucket identically.
function winprobFeatures() {
  const liqOf = (liqClass, liquidityUsd) => {
    if (typeof liqClass === 'string' && liqClass) return liqClass;
    try {
      const perf = require('./performance-analyzer.js');
      return perf.liqClassOf(liquidityUsd);
    } catch (_) {
      const v = Number(liquidityUsd);
      if (!Number.isFinite(v) || v <= 0) return 'medium';
      if (v >= 100000) return 'high';
      if (v >= 20000) return 'medium';
      return 'low';
    }
  };
  return [
    ['score', (t) => bucketScore(t.entryScore), (c) => bucketScore(c.score)],
    ['m1h', (t) => bucket1h(t.change1hPct), (c) => bucket1h(c.change1hPct)],
    ['m5m', (t) => bucket5m(t.recovery5mPct), (c) => bucket5m(c.recoveryPct)],
    ['liq', (t) => liqOf(t.liqClass, t.liquidityUsd), (c) => liqOf(null, c.liquidityUsd)],
    ['vol', (t) => bucketVol(t.volume24hUsd), (c) => bucketVol(c.volume24hUsd)],
    ['rsi', (t) => bucketRsi(t.rsi), (c) => bucketRsi(c.rsi && c.rsi.rsi)],
    ['spread', (t) => bucketSpread(t.spreadPct), (c) => bucketSpread(c.spreadPct)]
  ];
}

/** Train on closed trades → model { priorW, n, wins, feats } or null when
 *  below minTrain (caller fails the gate open). */
function trainWinProb(closedTrades, opts = {}) {
  const minTrain = opts.minTrain != null ? opts.minTrain : WINPROB_MIN_TRAIN;
  const alpha = opts.alpha != null ? opts.alpha : WINPROB_ALPHA;
  const list = (Array.isArray(closedTrades) ? closedTrades : []).filter((t) => t && typeof t === 'object');
  if (list.length < minTrain) return null;
  const feats = winprobFeatures();
  const wins = list.filter((t) => t.realizedPnlSol > 0);
  const losses = list.filter((t) => !(t.realizedPnlSol > 0));
  const model = {
    n: list.length, wins: wins.length, losses: losses.length, alpha,
    priorW: (wins.length + alpha) / (list.length + 2 * alpha),
    feats: {}
  };
  for (const [name, ofTrade] of feats) {
    const vocab = new Set(list.map((t) => String(ofTrade(t))));
    const V = Math.max(vocab.size, 2);
    const cw = {}, cl = {};
    for (const t of wins) {
      const k = String(ofTrade(t));
      cw[k] = (cw[k] || 0) + 1;
    }
    for (const t of losses) {
      const k = String(ofTrade(t));
      cl[k] = (cl[k] || 0) + 1;
    }
    model.feats[name] = { cw, cl, V };
  }
  return model;
}

/** P(win | candidate features) under the model (log-space, Laplace-smoothed).
 *  Returns null without a model (caller fails open). */
function predictWinProb(model, candidate) {
  if (!model || !model.feats) return null;
  const feats = winprobFeatures();
  let lp = Math.log(model.priorW);
  let lq = Math.log(1 - model.priorW);
  for (const [name, , ofCand] of feats) {
    const f = model.feats[name];
    if (!f) continue;
    const k = String(ofCand(candidate || {}));
    lp += Math.log(((f.cw[k] || 0) + model.alpha) / (model.wins + f.V * model.alpha));
    lq += Math.log(((f.cl[k] || 0) + model.alpha) / (model.losses + f.V * model.alpha));
  }
  const diff = lq - lp;
  if (diff > 700) return 0;
  if (diff < -700) return 1;
  return 1 / (1 + Math.exp(diff));
}

/** In-sample P(win) for every closed trade (threshold tuning input). */
function scoreWinProb(model, closedTrades) {
  return (Array.isArray(closedTrades) ? closedTrades : []).map((t) => {
    // Shim trade-shaped rows into candidate field names for the shared
    // candidate-side extractors (recoveryPct / rsi object / liqClass).
    const shim = { score: t.entryScore, change1hPct: t.change1hPct, recoveryPct: t.recovery5mPct, liquidityUsd: t.liquidityUsd, volume24hUsd: t.volume24hUsd, rsi: { rsi: t.rsi }, spreadPct: t.spreadPct };
    return { trade: t, p: predictWinProb(model, shim) };
  });
}

/** Tune the entry threshold for PROFIT FACTOR (not win rate): sweep the
 *  in-sample keep-set, argmax PF subject to minKeep + no-material-harm vs
 *  the unfiltered baseline (mirrors runBacktest tolerances). Falls back to
 *  defaultThreshold. Returns { threshold, stats, fallback }. */
function tuneThreshold(model, closedTrades, opts = {}) {
  const fallback = opts.defaultThreshold != null ? opts.defaultThreshold : WINPROB_DEFAULT_THRESHOLD;
  const list = (Array.isArray(closedTrades) ? closedTrades : []).filter((t) => t && typeof t === 'object');
  const minKeep = opts.minKeep != null ? opts.minKeep : Math.max(5, Math.floor(list.length * 0.2));
  const perf = require('./performance-analyzer.js');
  const base = perf.computeMetrics(list);
  const scored = scoreWinProb(model, list).filter((s) => Number.isFinite(s.p));
  let best = null;
  for (let th = 0.3; th <= 0.750001; th = Math.round((th + 0.05) * 100) / 100) {
    const keep = scored.filter((s) => s.p >= th).map((s) => s.trade);
    if (keep.length < minKeep) continue;
    const m = perf.computeMetrics(keep);
    // All-winner keep-sets report PF Infinity — the best case, not a skip.
    if (Number.isNaN(m.profitFactor)) continue;
    const better = !best || m.profitFactor > best.m.profitFactor + 1e-9 ||
      (Math.abs(m.profitFactor - best.m.profitFactor) < 1e-9 && (
        m.expectancyPct > best.m.expectancyPct + 1e-9 ||
        (Math.abs(m.expectancyPct - best.m.expectancyPct) < 1e-9 && keep.length > best.keep.length)));
    if (better) best = { th: Math.round(th * 100) / 100, keep, m };
  }
  if (!best) return { threshold: fallback, stats: null, fallback: true, reason: 'no threshold keeps min sample' };
  // No-material-harm vs unfiltered baseline (tolerances mirror runBacktest).
  if (best.m.profitFactor < base.profitFactor - 0.2 || best.m.expectancyPct < base.expectancyPct - 1.0) {
    return { threshold: fallback, stats: best, fallback: true, reason: 'tuned set hurts PF/expectancy vs baseline' };
  }
  return { threshold: best.th, stats: { n: best.m.n, winRate: best.m.winRate, expectancyPct: best.m.expectancyPct, profitFactor: best.m.profitFactor }, fallback: false };
}

module.exports = {
  V1,
  GATE_PARAMS,
  BOUNDS,
  MIN_SAMPLES,
  DEFAULT_CONFIDENCE_THRESHOLD,
  clusterKeyOf,
  passesWith,
  scoreSubset,
  learnGates,
  loadGates,
  saveGates,
  effectiveGates,
  gateSummary,
  WINPROB_ALPHA,
  WINPROB_MIN_TRAIN,
  WINPROB_DEFAULT_THRESHOLD,
  bucketScore,
  bucket1h,
  bucket5m,
  bucketVol,
  bucketRsi,
  bucketSpread,
  winprobFeatures,
  trainWinProb,
  predictWinProb,
  scoreWinProb,
  tuneThreshold,
  BANDIT_ARMS,
  BANDIT_MIN_SAMPLES,
  BANDIT_FILE,
  hashStr32,
  mulberry32,
  sampleGammaInt,
  sampleBetaInt,
  blankBanditState,
  loadBanditState,
  saveBanditState,
  banditCounts,
  banditClusterN,
  banditSelectArm,
  selectBanditArms,
  banditUpdateFromTrades,
  banditEffectiveArm,
  banditBacktest
};