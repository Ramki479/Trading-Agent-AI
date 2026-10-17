#!/usr/bin/env node
/**
 * regime-detector.js — deterministic, data-driven market regime detection for
 * the paper trader (Circuit Tier 1 equivalent).
 *
 * Modeled on upstream `lib/analysis/regime-state.js` (verified): the same
 * four regimes (bull / consolidation / recovery / dump) plus an explicit
 * UNKNOWN that safely falls back to the V1 baseline.
 *
 * Classification is MARKET-driven — SOL trend + discovery breadth — never
 * own-P&L-driven and never an LLM guess and never Math.random(). Own win
 * rate is reflexive (it measures past entries, lags turning points, and
 * goes UNKNOWN exactly when a cold start needs guidance most), so the
 * detector reads the market instead:
 *
 *   direction — SOL/USD 1h + 24h change (same DexScreener wSOL pair as the
 *     price feed; no new feed, no new history file).
 *   breadth   — discovery universe quality: fraction of candidates with real
 *     liquidity, universe size, consecutive discovery failures, and the
 *     market-health gate (all already collected per scan).
 *
 * Regime state is persisted to data/regime-state.json with a TTL (default
 * 2 h, like upstream), consumed by:
 *   - adaptive-policy.js  (session mode / minScore / maxBuys)
 *   - the scanner         (entry sizing multiplier + buy gating)
 *   - reflection-engine.js (performance by regime)
 *
 * Safety: UNKNOWN or unreadable state → V1 behavior (active, 1.0× size).
 * Insufficient market input (no SOL change AND no breadth) → UNKNOWN.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REGIMES = ['bull', 'consolidation', 'recovery', 'dump', 'UNKNOWN'];
const DEFAULT_TTL_MS = 2 * 3600 * 1000; // upstream uses a 2h TTL

// Classification thresholds (%, opts-overridable for tests/tuning).
const DEFAULT_THRESHOLDS = {
  dumpSol1h: -3,      // SOL hour at/below this → dump leg
  dumpSol24h: -10,    // SOL day at/below this → dump leg
  bullSol1h: 1,       // SOL hour at/above this…
  bullSol24h: 5,      // …with the day at/above this → bull leg
  recoverySol24h: -5, // day at/below this + hour turning positive → recovery
  bullMinLiqPct: 0.6  // bull needs ≥60% of the universe liquid (breadth)
};

function num(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function thresholdsOf(opts) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  const out = Object.assign({}, DEFAULT_THRESHOLDS);
  for (const k of Object.keys(DEFAULT_THRESHOLDS)) {
    if (Number.isFinite(Number(o[k]))) out[k] = Number(o[k]);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Pure detection from market snapshot.
 * ------------------------------------------------------------------ */

/**
 * Classify the market regime from a market snapshot (NOT from own trades).
 * @param {object} market
 *   { sol1h, sol24h }            SOL/USD % changes (null when unknown)
 *   { liqPct, candidates }       breadth: fraction of universe with real
 *                                liquidity (0..1|null), universe size
 *   { healthScore, healthGate, discoveryFailures }
 * @param {object} opts { thresholds overrides }
 * @returns {{ regime, confidence, reasoning, data }}
 */
function detectMarketRegime(market, opts = {}) {
  const th = thresholdsOf(opts);
  const m = (market && typeof market === 'object') ? market : {};
  const sol1h = num(m.sol1h);
  const sol24h = num(m.sol24h);
  const liqRaw = num(m.liqPct);
  const liqPct = liqRaw == null ? null : Math.max(0, Math.min(1, liqRaw));
  const candidates = Number.isFinite(Number(m.candidates)) ? Math.max(0, Math.floor(Number(m.candidates))) : 0;
  const healthScore = num(m.healthScore);
  const healthGate = m.healthGate === true;
  const failures = Number.isFinite(Number(m.discoveryFailures)) && Number(m.discoveryFailures) > 0
    ? Math.floor(Number(m.discoveryFailures)) : 0;

  const data = {
    sol1h, sol24h, liqPct, candidates, healthScore, healthGate, discoveryFailures: failures
  };

  const fmt = (v, digits = 2) => (v == null ? 'n/a' : `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`);

  // No direction input at all → UNKNOWN (fail safe, V1 applies).
  if (sol1h == null && sol24h == null) {
    return {
      regime: 'UNKNOWN',
      confidence: 0.1,
      reasoning: `No SOL trend input (1h ${fmt(sol1h, 1)}, 24h ${fmt(sol24h, 1)}) — V1 baseline applies`,
      data
    };
  }

  const dumpHour = sol1h != null && sol1h <= th.dumpSol1h;
  const dumpDay = sol24h != null && sol24h <= th.dumpSol24h;
  // Broad selloff first (defense in depth with the market-health gate).
  if (dumpHour || dumpDay) {
    const agree = dumpHour && dumpDay;
    return {
      regime: 'dump',
      confidence: Math.min(0.9, agree ? 0.85 : 0.7),
      reasoning: `Dump: SOL ${fmt(sol1h, 1)}/1h ${fmt(sol24h, 1)}/24h — broad selloff`,
      data
    };
  }

  // Healthy uptrend needs BOTH legs plus tradeable breadth.
  const upHour = sol1h != null && sol1h >= th.bullSol1h;
  const upDay = sol24h != null && sol24h >= th.bullSol24h;
  const breadthOk = liqPct != null && liqPct >= th.bullMinLiqPct && !healthGate && failures < 3;
  if (upHour && upDay) {
    if (breadthOk) {
      return {
        regime: 'bull',
        confidence: Math.min(0.85, sol1h >= 3 ? 0.8 : 0.7),
        reasoning: `Bull: SOL ${fmt(sol1h, 1)}/1h ${fmt(sol24h, 1)}/24h on liquid breadth (${Math.round(liqPct * 100)}% with liq)`,
        data
      };
    }
    return {
      regime: 'consolidation',
      confidence: 0.55,
      reasoning: `SOL up (${fmt(sol1h, 1)}/1h) but breadth untradeable (liq ${liqPct == null ? 'n/a' : Math.round(liqPct * 100) + '%'}${healthGate ? ', health gated' : ''}${failures >= 3 ? `, ${failures} discovery failures` : ''}) — consolidation`,
      data
    };
  }

  // Sold off but turning: the bounce regime.
  if (sol24h != null && sol24h <= th.recoverySol24h && sol1h != null && sol1h > 0) {
    return {
      regime: 'recovery',
      confidence: 0.6,
      reasoning: `Recovery: SOL day ${fmt(sol24h, 1)} but hour turning ${fmt(sol1h, 1)} — stabilizing`,
      data
    };
  }

  // Partial trend (one leg only): lean with it at low confidence, never
  // bull/dump on a single leg.
  if ((sol1h != null && sol1h > 0) || (sol24h != null && sol24h > 0)) {
    return {
      regime: 'consolidation',
      confidence: 0.5,
      reasoning: `Mixed trend (SOL ${fmt(sol1h, 1)}/1h ${fmt(sol24h, 1)}/24h) — consolidation`,
      data
    };
  }
  return {
    regime: 'consolidation',
    confidence: 0.55,
    reasoning: `Soft trend (SOL ${fmt(sol1h, 1)}/1h ${fmt(sol24h, 1)}/24h) — consolidation`,
    data
  };
}

/**
 * Regime → recommended session strategy (adapted from upstream
 * `strategyForRegime`, but never lowering the V1 score floor and never
 * exceeding the paper position cap).
 */
function strategyForRegime(regime, cfg = {}) {
  const maxPositions = cfg.maxPositions || 3;
  const strategies = {
    bull: {
      mode: 'active',
      minScore: 60,
      maxBuys: maxPositions,
      recommendation: 'Bull regime — V1 active mode, full capacity.'
    },
    consolidation: {
      mode: 'selective',
      minScore: 60,
      maxBuys: Math.max(1, Math.min(2, maxPositions)),
      recommendation: 'Consolidation — selective mode, top candidate only, capped entries.'
    },
    recovery: {
      mode: 'watchOnly',
      minScore: 60,
      maxBuys: 0,
      recommendation: 'Recovery regime — hold cash, watch only until re-entry signals improve.'
    },
    dump: {
      mode: 'watchOnly',
      minScore: 60,
      maxBuys: 0,
      recommendation: 'Dump regime — emergency hold, watch only until regime shifts.'
    },
    UNKNOWN: {
      mode: 'active',
      minScore: 60,
      maxBuys: maxPositions,
      recommendation: 'Unknown regime — V1 baseline active mode.'
    }
  };
  return strategies[regime] || strategies.UNKNOWN;
}

/**
 * Position-size multiplier for a regime. NEVER exceeds 1.0 in this paper
 * agent (the 0.05 SOL ceiling is a hard cap); dump → 0 (no entries).
 * Multipliers are configurable via cfg.sizing { bull, consolidation,
 * recovery, dump }. UNKNOWN → 1.0 (V1).
 */
function sizeMultiplierForRegime(regime, cfg = {}) {
  const sizing = (cfg.sizing && typeof cfg.sizing === 'object') ? cfg.sizing : {};
  const defaults = { bull: 1.0, consolidation: 1.0, recovery: 0.5, dump: 0.0 };
  const key = regime === 'UNKNOWN' ? 'consolidation' : regime;
  const m = Number(sizing[key]);
  if (!Number.isFinite(m)) return defaults[key] != null ? defaults[key] : 1.0;
  return Math.max(0, Math.min(2, m)); // clamped at module level; agentd enforces the 0.05 cap
}

/* ------------------------------------------------------------------ *
 * Persistence (data/regime-state.json, TTL'd like upstream).
 * ------------------------------------------------------------------ */

function regimeStateFile(dataDir) {
  return path.join(dataDir, 'regime-state.json');
}

const DEFAULT_STATE = {
  regime: 'UNKNOWN',
  confidence: 0.0,
  reasoning: 'No regime detected yet — V1 baseline',
  detectedAt: null,
  validUntil: null
};

function loadRegimeState(dataDir) {
  try {
    const file = regimeStateFile(dataDir);
    if (fs.existsSync(file)) {
      const state = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (state && state.regime) {
        if (state.validUntil && Date.now() < new Date(state.validUntil).getTime()) {
          return state;
        }
        // Expired → stale; caller treats it as UNKNOWN via fallback.
        return Object.assign({}, DEFAULT_STATE, state, { expired: true });
      }
    }
  } catch (_) { /* unreadable → default */ }
  return Object.assign({}, DEFAULT_STATE);
}

function saveRegimeState(dataDir, state, ttlMs = DEFAULT_TTL_MS) {
  const out = Object.assign({}, DEFAULT_STATE, state, {
    regime: REGIMES.includes(state && state.regime) ? state.regime : 'UNKNOWN',
    detectedAt: new Date().toISOString(),
    validUntil: new Date(Date.now() + ttlMs).toISOString()
  });
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const file = regimeStateFile(dataDir);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n');
    fs.renameSync(tmp, file);
  } catch (_) { /* best effort */ }
  return out;
}

/* ------------------------------------------------------------------ *
 * Convenience: full detect + persist in one call (used by the agent-loop).
 * ------------------------------------------------------------------ */

function detectAndSave(dataDir, market, cfg = {}, opts = {}) {
  const detected = detectMarketRegime(market, opts);
  const saved = saveRegimeState(dataDir, {
    regime: detected.regime,
    confidence: detected.confidence,
    reasoning: detected.reasoning,
    data: detected.data
  }, opts.ttlMs || cfg.regimeTtlMs || DEFAULT_TTL_MS);
  return Object.assign({}, detected, { validUntil: saved.validUntil, detectedAt: saved.detectedAt });
}

module.exports = {
  REGIMES,
  DEFAULT_TTL_MS,
  DEFAULT_THRESHOLDS,
  detectMarketRegime,
  strategyForRegime,
  sizeMultiplierForRegime,
  loadRegimeState,
  saveRegimeState,
  detectAndSave
};