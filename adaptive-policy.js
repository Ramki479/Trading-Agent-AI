#!/usr/bin/env node
/**
 * adaptive-policy.js — Circuit agent-loop equivalent: the bounded session
 * policy that steers the scanner for the next window (default 90 minutes).
 *
 * Upstream (lib/agent-loop.js, verified) writes data/session_strategy.json
 * with { mode, patternFilter, minScoreOverride, maxBuysThisSession, ... } and
 * a 90-minute TTL; the scanner reads it every tick and falls back to active +
 * defaults when expired. We reproduce that mechanism deterministically:
 *
 *   - mode       : active | selective | watchOnly   (same names as upstream)
 *   - minScore   : V1 floor 60, can only RAISE (60..90)
 *   - maxBuys    : 0..MAX_POSITIONS session buy cap (0 = no entries)
 *   - regime     : from regime-detector (bull/consolidation/recovery/dump/UNKNOWN)
 *   - confidence : regime confidence
 *   - strategyVersion : the current persistent strategy version (V1, V1.1, …)
 *   - sizeMultiplier  : regime-based entry-size multiplier (0..1, never >1)
 *
 * Deterministic engine by default; an optional async LLM hook (llm-adapter.js,
 * CIRCUIT_LLM_URL + key) may reinterpret the same schema — its output is
 * schema-validated and clamped before it can override anything. The scanner
 * NEVER waits on the LLM (no hot-path LLM).
 *
 * Persisted to data/adaptive-policy.json (atomic writes).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const regimeLib = require('./regime-detector.js');

const MODES = ['active', 'selective', 'watchOnly'];
const DEFAULT_TTL_MS = 90 * 60 * 1000; // verified upstream: 90-minute session
const MIN_SCORE_FLOOR = 60;
const MIN_SCORE_CEILING = 90;
const DEFAULT_DAILY_LOSS_HALT_PCT = 3; // day P&L at/below -3% → watchOnly rest of day

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function defaultPolicy() {
  return {
    mode: 'active',
    minScore: 60,
    maxBuys: 3,
    strategyVersion: 'V1',
    regime: 'UNKNOWN',
    confidence: 0,
    reason: 'V1 baseline — no adaptive signal yet',
    setAt: null,
    expiresAt: null,
    buysThisSession: 0,
    sizeMultiplier: 1.0,
    source: 'deterministic'
  };
}

function policyFile(dataDir) {
  return path.join(dataDir, 'adaptive-policy.json');
}

function loadPolicy(dataDir) {
  try {
    const file = policyFile(dataDir);
    if (fs.existsSync(file)) {
      const p = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (p && typeof p === 'object') return Object.assign(defaultPolicy(), p);
    }
  } catch (_) { /* unreadable → default */ }
  return defaultPolicy();
}

function savePolicy(dataDir, policy, ttlMs = DEFAULT_TTL_MS, opts = {}) {
  const out = Object.assign({}, policy, {
    mode: MODES.includes(policy.mode) ? policy.mode : 'active',
    minScore: clamp(Number(policy.minScore) || MIN_SCORE_FLOOR, MIN_SCORE_FLOOR, MIN_SCORE_CEILING),
    maxBuys: Math.max(0, Math.min(Number(policy.maxBuys) || 0, policy.maxBuysCap || 3)),
    sizeMultiplier: Math.max(0, Math.min(Number(policy.sizeMultiplier) || 1, 1)),
    // A buy-counter write must NOT reset the session TTL (upstream preserves
    // expiresAt on counter increments) — opt in with preserveTtl.
    setAt: opts.preserveTtl && policy.setAt ? policy.setAt : new Date().toISOString(),
    expiresAt: opts.preserveTtl && policy.expiresAt ? policy.expiresAt : new Date(Date.now() + ttlMs).toISOString()
  });
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const file = policyFile(dataDir);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch (_) { /* best effort */ }
  return out;
}

function isFresh(policy, now = Date.now()) {
  return !!(policy && policy.expiresAt && Date.now() < new Date(policy.expiresAt).getTime());
}

/** Scanner-facing gates: expired/missing policy → V1 (active, 60, full cap). */
function effectiveGates(policy, cfg = {}) {
  const maxPositions = cfg.maxPositions || 3;
  if (!isFresh(policy)) {
    return {
      mode: 'active',
      minScore: MIN_SCORE_FLOOR,
      maxBuys: maxPositions,
      fresh: false,
      reason: 'V1 fallback (policy missing or expired)'
    };
  }
  return {
    mode: MODES.includes(policy.mode) ? policy.mode : 'active',
    minScore: clamp(Number(policy.minScore) || MIN_SCORE_FLOOR, MIN_SCORE_FLOOR, MIN_SCORE_CEILING),
    maxBuys: Math.max(0, Math.min(Number(policy.maxBuys) || maxPositions, maxPositions)),
    fresh: true,
    reason: policy.reason
  };
}

/** Did the session policy materially change? */
function policyChanged(a, b) {
  if (!a || !b) return true;
  return a.mode !== b.mode ||
    (a.minScore || 60) !== (b.minScore || 60) ||
    (a.maxBuys || 3) !== (b.maxBuys || 3) ||
    a.strategyVersion !== b.strategyVersion ||
    a.regime !== b.regime;
}

/**
 * Build the next session policy (deterministic).
 * @param {object} input { metrics, regime, current, cfg, trades, dayPnlPct }
 *   metrics: from performance-analyzer.computeMetrics (recent window)
 *   regime:  from regime-detector.detectMarketRegime (SOL trend + breadth)
 *   current: current persisted policy (for context/continuity)
 *   cfg:     { maxPositions, strategyVersion, lossBreakerThreshold, dailyLossHaltPct }
 *   trades:  closed trades (for the current-streak calculation)
 *   dayPnlPct: day-to-date account P&L % vs day anchor (null = unknown → no halt)
 * @returns {object} policy (unsaved) — save with savePolicy()
 */
function buildSessionPolicy(input = {}) {
  const cfg = input.cfg || {};
  const maxPositions = cfg.maxPositions || 3;
  const metrics = input.metrics || {};
  const regime = input.regime || { regime: 'UNKNOWN', confidence: 0, reasoning: '' };
  const current = input.current || defaultPolicy();

  const strat = regimeLib.strategyForRegime(regime.regime, { maxPositions });
  let mode = strat.mode;
  let minScore = MIN_SCORE_FLOOR;
  let maxBuys = Math.max(0, Math.min(strat.maxBuys, maxPositions));
  let reason = regime.reasoning || strat.recommendation;

  // Daily loss halt (dominates everything below: a breached day stays shut
  // until the UTC date rolls, regardless of streaks/regime).
  const haltPct = cfg.dailyLossHaltPct != null ? cfg.dailyLossHaltPct : DEFAULT_DAILY_LOSS_HALT_PCT;
  const dayPnl = Number(input.dayPnlPct);
  if (haltPct > 0 && Number.isFinite(dayPnl) && dayPnl <= -Math.abs(haltPct)) {
    return {
      mode: 'watchOnly',
      maxBuys: 0,
      minScore,
      strategyVersion: cfg.strategyVersion || (current.strategyVersion || 'V1'),
      regime: regime.regime,
      confidence: Math.round((regime.confidence || 0) * 100) / 100,
      reason: String(`Daily loss halt: day P&L ${dayPnl.toFixed(2)}% ≤ -${Math.abs(haltPct)}% — watch only until next UTC day. ${reason}`).slice(0, 500),
      buysThisSession: 0,
      sizeMultiplier: regimeLib.sizeMultiplierForRegime(regime.regime, cfg.sizing ? { sizing: cfg.sizing } : {}),
      source: 'deterministic',
      maxBuysCap: maxPositions
    };
  }

  const trades = Array.isArray(input.trades) ? input.trades : [];
  const recent = trades.slice(-10);
  let consecLosses = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].realizedPnlSol <= 0) consecLosses += 1;
    else break;
  }
  const lossBreaker = cfg.lossBreakerThreshold != null ? cfg.lossBreakerThreshold : 3;

  // Deterministic circuit breaker (upstream: 3 consecutive losses → pause):
  // 3+ consecutive losses → watchOnly for this window; 2 → selective, 1 buy.
  if (consecLosses >= lossBreaker && mode !== 'watchOnly') {
    mode = 'watchOnly';
    maxBuys = 0;
    reason = `Circuit breaker: ${consecLosses} consecutive losses — watch only this window. ${reason}`;
  } else if (consecLosses === 2 && mode === 'active') {
    mode = 'selective';
    maxBuys = Math.min(maxBuys, 1);
    reason = `Selective: ${consecLosses} consecutive losses — single top candidate only. ${reason}`;
  }

  // Tighter score when recent expectancy is negative (never below V1's 60).
  if (metrics.n >= 5 && metrics.expectancyPct < -2) {
    minScore = clamp(minScore + 5, MIN_SCORE_FLOOR, MIN_SCORE_CEILING);
    reason += ` | raised minScore to ${minScore} (7d expectancy ${metrics.expectancyPct.toFixed(1)}%)`;
  }

  const sizeMultiplier = regimeLib.sizeMultiplierForRegime(regime.regime, cfg.sizing ? { sizing: cfg.sizing } : {});

  return {
    mode,
    minScore,
    maxBuys,
    strategyVersion: cfg.strategyVersion || (current.strategyVersion || 'V1'),
    regime: regime.regime,
    confidence: Math.round((regime.confidence || 0) * 100) / 100,
    reason: String(reason).slice(0, 500),
    buysThisSession: 0,
    sizeMultiplier,
    source: 'deterministic',
    maxBuysCap: maxPositions
  };
}

/* ------------------------------------------------------------------ *
 * Session buy counter — in-memory atomic counter synced to the file
 * (mirrors upstream incrementSessionBuy; avoids load-modify-save races).
 * ------------------------------------------------------------------ */

let _sessionBuyCount = null;

function incrementSessionBuy(dataDir) {
  if (_sessionBuyCount === null) {
    _sessionBuyCount = Number(loadPolicy(dataDir).buysThisSession) || 0;
  }
  _sessionBuyCount += 1;
  try {
    const p = loadPolicy(dataDir);
    savePolicy(dataDir, Object.assign({}, p, { buysThisSession: _sessionBuyCount }), policyTtlOf(p), { preserveTtl: true });
  } catch (_) { /* best effort */ }
  return _sessionBuyCount;
}

function policyTtlOf(policy) {
  if (!policy || !policy.setAt || !policy.expiresAt) return DEFAULT_TTL_MS;
  const ttl = new Date(policy.expiresAt).getTime() - new Date(policy.setAt).getTime();
  return Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TTL_MS;
}

module.exports = {
  MODES,
  DEFAULT_TTL_MS,
  MIN_SCORE_FLOOR,
  MIN_SCORE_CEILING,
  DEFAULT_DAILY_LOSS_HALT_PCT,
  defaultPolicy,
  loadPolicy,
  savePolicy,
  isFresh,
  effectiveGates,
  policyChanged,
  buildSessionPolicy,
  incrementSessionBuy,
  clamp
};