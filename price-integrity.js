#!/usr/bin/env node
/**
 * price-integrity.js — market-price integrity protection for the paper trader.
 *
 * Position in the pipeline (BELOW the strategy — it never changes trading):
 *
 *   MARKET DATA
 *       ↓
 *   PRICE INTEGRITY        ← this module
 *       ↓
 *   EXISTING STRATEGY      (Circuit Agent / V1 — UNCHANGED)
 *       ↓
 *   PAPER ACCOUNTING
 *
 * This module answers exactly ONE question for an OPEN POSITION: is a market
 * observation trustworthy enough to use for accounting (SL/TP, P&L, equity)?
 *
 *   valid market observation
 *        |
 *        +-- valid identity/source/price
 *        |        |
 *        |        +-- existing strategy monitor (SL/TP — unchanged)
 *        |
 *        +-- invalid/suspicious observation
 *                 |
 *                 +-- NO SELL
 *                 +-- log [PRICE-INTEGRITY] warning
 *                 +-- wait for confirmation / valid matching observation
 *
 * It does NOT decide whether a token is a good trade, does NOT change any
 * BUY/SELL signal and contains NO strategy thresholds (STOP_LOSS / TAKE_PROFIT
 * / 5m-1h gates / cooldown / score all remain in agentd.js, untouched).
 *
 * Protection (all about accounting integrity, not strategy):
 *   1. mint stays the canonical identity — never symbol alone.
 *   2. pair identity must match the pair the position was opened on; a changed
 *      pair is never used to sell an existing position.
 *   3. prices must be finite, > 0, fresh and from a known source.
 *   4. an extreme single-step move (vs. the last valid price) is never acted
 *      on immediately: it is quarantined until subsequent valid observations
 *      confirm the market genuinely moved (or an independent source agrees).
 *      Adverse extremes (long-only book: down past gapKillPct) fast-confirm
 *      on ONE consistent print — a real gap exits a cycle earlier — while a
 *      single anomalous print still never sells (a snap-back resolves the
 *      quarantine untouched). Favorable extremes keep full confirmations.
 *      Legitimate large moves are still eventually recognized; one anomalous
 *      print can never manufacture a fake -99% loss or +100% gain.
 *   5. state (last valid price/pair/source, quarantines, counters, warnings)
 *      persists to price-integrity.json inside the agent data dir and survives
 *      restarts. This file is the ONLY thing this module ever writes.
 *
 * PAPER-ONLY: no wallet, no keys, no signing, no broadcast, no ledger writes,
 * no portfolio mutation — pure read-only integrity decisions + its own state.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const marketDataLib = require('./market-data.js'); // reuse — never duplicate market-data logic

const FILE_NAME = 'price-integrity.json';

// Sources the engine can observe. 'mock' is the test-only provider; real runs
// use 'dexscreener' (and optionally 'circuit').
const KNOWN_SOURCES = ['dexscreener', 'circuit', 'mock'];

// A single-step relative move (vs. the last VALID price) of >= 50% is treated
// as suspicious and must be confirmed before it may touch accounting. This is
// a DATA-INTEGRITY knob, NOT a trading rule: it never blocks a move forever —
// a sustained move is accepted after CONFIRMATIONS_REQUIRED consistent prints.
const DEFAULT_EXTREME_MOVE_PCT = 50;
// Subsequent consistent observations required before a quarantined move is
// accepted (the flagged print itself does not count).
const DEFAULT_CONFIRMATIONS_REQUIRED = 2;
// Gap/slippage kill (RISK exit, not integrity): a single-poll adverse move at
// or beyond this size, or a liquidity pull at or beyond LIQ_DROP_PCT, is
// treated by the agent monitor as a real rug/gap and exits immediately instead
// of waiting for quarantine confirmation. The observation must still pass the
// identity/validity gate (fresh, known source, pair unchanged) — the kill
// bypasses CONFIRMATION only, never validity.
const DEFAULT_GAP_KILL_PCT = 20;
const DEFAULT_LIQ_DROP_PCT = 50;
// Rejections that repeat every monitor cycle are logged at most this often.
const LOG_THROTTLE_MS = 60 * 1000;
// Ring of recent integrity events kept in the state file.
const MAX_EVENTS = 40;

/* ------------------------------------------------------------------ *
 * Small helpers.
 * ------------------------------------------------------------------ */

function round2(n) {
  return Math.round(n * 100) / 100;
}

function nowIso(ts) {
  return new Date(ts).toISOString();
}

function atomicWriteJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** True when both prices are finite and > 0. */
function sanePair(prevSol, obsSol) {
  return Number.isFinite(prevSol) && prevSol > 0 &&
    Number.isFinite(obsSol) && obsSol > 0;
}

/* ------------------------------------------------------------------ *
 * Pure validation helpers (unit-testable, no state, no I/O).
 * ------------------------------------------------------------------ */

/**
 * Structural / freshness validation of a raw market observation.
 * Returns { ok: true } or { ok: false, reason, detail }.
 * Checks (Requirement 2.3 / 2.4):
 *   - priceUsd and priceSol are finite and > 0
 *   - the price source is known
 *   - the price is fresh under the caller's maxAgeMs policy
 */
function validateMarketObservation(observation, opts = {}) {
  const maxAgeMs = opts.maxAgeMs || 60000;
  const now = opts.now != null ? opts.now : Date.now();
  const known = opts.knownSources || KNOWN_SOURCES;
  if (!observation || typeof observation !== 'object') {
    return { ok: false, reason: 'INVALID_OBSERVATION', detail: 'missing market observation' };
  }
  const { priceUsd, priceSol, source, timestamp, ageMs } = observation;
  if (!(Number.isFinite(priceUsd) && priceUsd > 0)) {
    return { ok: false, reason: 'INVALID_PRICE_USD', detail: `priceUsd=${priceUsd}` };
  }
  if (!(Number.isFinite(priceSol) && priceSol > 0)) {
    return { ok: false, reason: 'INVALID_PRICE_SOL', detail: `priceSol=${priceSol}` };
  }
  if (known.indexOf(source) < 0) {
    return { ok: false, reason: 'UNKNOWN_SOURCE', detail: `source=${source}` };
  }
  const age = Number.isFinite(ageMs) && ageMs >= 0
    ? ageMs
    : (Number.isFinite(timestamp) ? Math.max(0, now - timestamp) : null);
  if (age === null) {
    return { ok: false, reason: 'STALE_PRICE', detail: 'no usable timestamp' };
  }
  if (age > maxAgeMs) {
    return { ok: false, reason: 'STALE_PRICE', detail: `ageMs=${Math.round(age)}` };
  }
  return { ok: true };
}

/**
 * Pair-identity check (Requirement 2.2). Only applies when BOTH pair
 * addresses are available — a missing pair address on either side means the
 * identity cannot be compared (e.g. a primary source without pool metadata),
 * and is reported as { changed: false, comparable: false }.
 */
function detectPairChange(oldPair, newPair) {
  if (!oldPair || !newPair) return { changed: false, comparable: false };
  if (oldPair === newPair) return { changed: false, comparable: true };
  return { changed: true, comparable: true, oldPair, newPair };
}

/**
 * Cross-source divergence (Requirement 4) — delegates to the EXISTING
 * divergence comparator in market-data.js so there is exactly one divergence
 * definition and one configured threshold.
 */
function comparePriceSources(a, b, maxDivergencePct) {
  return marketDataLib.comparePrices(a, b, maxDivergencePct);
}

/**
 * Extreme single-step move detection (Requirement 3). Compares an observed
 * price against the last VALID price. Returns
 * { suspicious, changePct }. This is a flag, not a verdict: a suspicious
 * observation still needs confirmation before it may reach accounting.
 */
function detectSuspiciousPriceMove(prevSol, obsSol, opts = {}) {
  const extremeMovePct = opts.extremeMovePct != null ? opts.extremeMovePct : DEFAULT_EXTREME_MOVE_PCT;
  if (!sanePair(prevSol, obsSol)) return { suspicious: false, changePct: null };
  const changePct = ((obsSol / prevSol) - 1) * 100;
  return { suspicious: Math.abs(changePct) >= extremeMovePct, changePct: round2(changePct) };
}

/**
 * Gap/slippage kill decision (pure, risk exit — NOT an integrity verdict).
 * Scores one monitor poll for immediate-exit candidacy. Validity
 * (fresh/known-source/pair) must already have passed — this function only
 * looks at magnitudes.
 *
 * CONTRACT (ZCAT rule): only the LIQUIDITY leg bypasses quarantine outright
 * (a drained pool corroborates independently — a bad price print does not
 * drain liquidity). Price legs are INFORMATIONAL here: adverse extremes
 * fast-confirm inside checkPositionObservation (1 print, not 2) instead of
 * bypassing. The monitor acts on 'liquidity-kill' only.
 *
 * @param {object} input { singleStepPct, absPnlPct, liqDropPct }
 *   singleStepPct — one-poll move vs last VALID price (negative = adverse).
 *   absPnlPct     — unrealized vs entry.
 *   liqDropPct    — (entryLiq - obsLiq)/entryLiq*100, or null when unknown.
 * @param {object} opts { gapKillPct, liqDropPct }
 * @returns {{ kill: boolean, reason: null|'gap-kill'|'liquidity-kill',
 *             singleStepPct, absPnlPct, liqDropPct }}
 *   Price gap takes precedence over a liquidity-only pull.
 */
function detectGapKill(input = {}, opts = {}) {
  const gapKillPct = opts.gapKillPct != null ? opts.gapKillPct : DEFAULT_GAP_KILL_PCT;
  const liqDropThreshold = opts.liqDropPct != null ? opts.liqDropPct : DEFAULT_LIQ_DROP_PCT;
  const toNumOrNull = (v) => (v == null ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
  const single = toNumOrNull(input.singleStepPct);
  const abs = toNumOrNull(input.absPnlPct);
  const liq = toNumOrNull(input.liqDropPct);
  // Adverse price gap: one poll down >= threshold, or deep absolute loss that
  // slipped through SL while quarantined (e.g. -96% LARRY, -15% JUPCAT).
  if ((single != null && single <= -Math.abs(gapKillPct)) ||
      (abs != null && abs <= -Math.abs(gapKillPct))) {
    return { kill: true, reason: 'gap-kill', singleStepPct: single, absPnlPct: abs, liqDropPct: liq };
  }
  // Liquidity rug pull: pool drained >= threshold even before price prints it.
  if (liq != null && liq >= Math.abs(liqDropThreshold)) {
    return { kill: true, reason: 'liquidity-kill', singleStepPct: single, absPnlPct: abs, liqDropPct: liq };
  }
  return { kill: false, reason: null, singleStepPct: single, absPnlPct: abs, liqDropPct: liq };
}

/**
 * Identity/source/validity gate for one observation against one open position
 * (Requirements 2 + 4). Pure: performs no state transition.
 * opts: { maxAgeMs, now, knownSources, maxDivergencePct, independent }
 *   independent — optional raw observation from a second price source; when
 *   provided and divergent beyond maxDivergencePct the observation is
 *   rejected (SOURCE_DIVERGENCE).
 * Returns { ok: true } or { ok: false, reason, detail }.
 */
function validatePositionPrice({ position, observation, opts = {} }) {
  if (!position || !position.mint) {
    return { ok: false, reason: 'INVALID_OBSERVATION', detail: 'missing position (mint is canonical identity)' };
  }
  if (!observation || observation.mint == null) {
    return { ok: false, reason: 'INVALID_OBSERVATION', detail: 'missing observation mint' };
  }
  if (observation.mint !== position.mint) {
    return { ok: false, reason: 'MINT_MISMATCH',
      detail: `positionMint=${position.mint} observedMint=${observation.mint}` };
  }
  const v = validateMarketObservation(observation, opts);
  if (!v.ok) return v;
  const pair = detectPairChange(position.pairAddress, observation.pairAddress);
  if (pair.changed) {
    return { ok: false, reason: 'PAIR_CHANGED',
      detail: `oldPair=${pair.oldPair} newPair=${pair.newPair}` };
  }
  const independent = opts.independent;
  if (independent) {
    const cmp = comparePriceSources(observation, independent, opts.maxDivergencePct != null ? opts.maxDivergencePct : 25);
    if (!cmp.ok) {
      return { ok: false, reason: 'SOURCE_DIVERGENCE',
        detail: `source_a=${observation.source || '?'} source_b=${independent.source || '?'} divergence=${cmp.divergencePct == null ? 'n/a' : cmp.divergencePct + '%'}` };
    }
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ *
 * State (persisted to <dataDir>/price-integrity.json).
 * ------------------------------------------------------------------ */

function blankState() {
  return {
    version: 1,
    updatedAt: null,
    lastCheckAt: null,
    counters: {
      suspiciousObservations: 0,   // extreme moves flagged for confirmation
      rejectedObservations: 0,     // observations rejected for accounting
      pairChangesDetected: 0,
      sourceDivergenceEvents: 0
    },
    lastWarning: null,             // { ts, iso, symbol, mint, reason, detail }
    events: [],                    // recent integrity events (ring)
    mints: {}                      // mint -> open-position identity + last valid price
  };
}

/** Summary mapping shared with the read-only dashboard (no writes). */
function summarize(state) {
  const mints = state.mints || {};
  const quarantined = [];
  for (const mint of Object.keys(mints)) {
    const st = mints[mint];
    if (st && st.quarantine) {
      const q = st.quarantine;
      quarantined.push({
        symbol: st.symbol || null,
        mint,
        reason: 'EXTREME_PRICE_MOVE',
        since: q.since,
        direction: q.direction,
        confirmations: q.confirmations,
        required: q.required,
        observedPriceSol: q.firstObservedSol,
        observedPriceUsd: q.firstObservedUsd,
        baselinePriceSol: q.baselineSol
      });
    }
  }
  return {
    enabled: true,
    status: 'ok',
    lastCheckAt: state.lastCheckAt || state.updatedAt || null,
    counters: state.counters || blankState().counters,
    quarantined,
    lastWarning: state.lastWarning || null,
    events: (state.events || []).slice(-12)
  };
}

/* ------------------------------------------------------------------ *
 * createPriceIntegrity — the integrity manager used by the agent.
 * ------------------------------------------------------------------ */

/**
 * options:
 *   dataDir                agent data directory (persistence — default cwd)
 *   maxAgeMs               existing freshness policy (CIRCUIT_MAX_PRICE_AGE_MS)
 *   maxDivergencePct       existing divergence policy (CIRCUIT_MAX_DIVERGENCE_PCT)
 *   extremeMovePct         integrity-only flag threshold (default 50)
 *   confirmationsRequired  consistent prints before acceptance (default 2)
 *   gapKillPct             adverse single-step at/beyond this size needs only
 *                          ONE confirmation (default 20) — real gaps exit a
 *                          cycle earlier; single prints still never sell (a
 *                          snap-back resolves the quarantine untouched)
 *   knownSources           allowed price sources (default KNOWN_SOURCES)
 *   log(msg)               human-readable log sink ([PRICE-INTEGRITY] lines)
 *
 * Manager methods:
 *   notePositionOpened(position, { preserve })
 *   checkPositionObservation({ position, observation, now, independent })
 *   notePositionClosed(mint)
 *   noteSourceDivergence(rawMsg)
 *   snapshot()
 *   persist()
 */
function createPriceIntegrity(options = {}) {
  const dataDir = options.dataDir || process.cwd();
  const stateFile = path.join(dataDir, FILE_NAME);
  const maxAgeMs = options.maxAgeMs != null ? options.maxAgeMs : 60000;
  const maxDivergencePct = options.maxDivergencePct != null ? options.maxDivergencePct : 25;
  const extremeMovePct = options.extremeMovePct != null ? options.extremeMovePct : DEFAULT_EXTREME_MOVE_PCT;
  const confirmationsRequired = options.confirmationsRequired != null ? options.confirmationsRequired : DEFAULT_CONFIRMATIONS_REQUIRED;
  const gapKillPct = options.gapKillPct != null ? options.gapKillPct : DEFAULT_GAP_KILL_PCT;
  const knownSources = options.knownSources || KNOWN_SOURCES;
  const log = typeof options.log === 'function' ? options.log : () => {};

  const state = blankState();
  let dirty = false;
  // throttle: reason -> last logged ts (per mint)
  const lastLogAt = new Map();

  try {
    if (fs.existsSync(stateFile)) {
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (raw && typeof raw === 'object') {
        state.counters = Object.assign(blankState().counters, raw.counters || {});
        state.lastWarning = raw.lastWarning || null;
        state.events = Array.isArray(raw.events) ? raw.events.slice(-MAX_EVENTS) : [];
        state.mints = raw.mints && typeof raw.mints === 'object' ? raw.mints : {};
        state.updatedAt = raw.updatedAt || null;
        state.lastCheckAt = raw.lastCheckAt || null;
      }
    }
  } catch (err) {
    log(`state unreadable (${err.message}) — starting fresh`);
  }

  function markDirty() {
    dirty = true;
    state.updatedAt = Date.now();
  }

  function persist() {
    if (!dirty) return;
    dirty = false;
    state.events = state.events.slice(-MAX_EVENTS);
    try {
      atomicWriteJson(stateFile, state);
    } catch (err) {
      // Never crash the agent over diagnostics; retry on the next change.
      dirty = true;
      log(`could not persist integrity state (${err.message})`);
    }
  }

  /** One incident line: logs (throttled per mint+reason), counters, events. */
  function recordIncident({ symbol, mint, reason, detail, counter, warning }) {
    const now = Date.now();
    const key = `${mint || ''}|${reason}`;
    const last = lastLogAt.get(key) || 0;
    if (now - last < LOG_THROTTLE_MS) {
      return false; // already logged this incident recently — do not spam
    }
    lastLogAt.set(key, now);
    const ev = {
      ts: now,
      iso: nowIso(now),
      symbol: symbol || null,
      mint: mint || null,
      reason,
      detail: detail || ''
    };
    state.events.push(ev);
    if (state.events.length > MAX_EVENTS) state.events.shift();
    if (counter && state.counters[counter] != null) state.counters[counter] += 1;
    if (warning) state.lastWarning = { ts: ev.ts, iso: ev.iso, symbol: ev.symbol, mint: ev.mint, reason: ev.reason, detail: ev.detail };
    markDirty();
    const parts = [];
    if (ev.symbol) parts.push(`symbol=${ev.symbol}`);
    if (ev.mint) parts.push(`mint=${ev.mint}`);
    parts.push(`reason=${ev.reason}`);
    if (ev.detail) parts.push(ev.detail);
    log(parts.join(' '));
    return true;
  }

  /** Seed/refresh per-mint identity state from a position object. */
  function mintState(position, now, preserve) {
    const mint = position && position.mint;
    if (!mint) return null;
    let st = state.mints[mint];
    const freshSeed = {
      symbol: position.symbol || null,
      pairAddress: position.pairAddress || null,
      dex: position.dex || null,
      source: position.priceSource || null,
      lastValidPriceSol: (Number.isFinite(position.currentPriceSol) && position.currentPriceSol > 0)
        ? position.currentPriceSol
        : ((Number.isFinite(position.entryPriceSol) && position.entryPriceSol > 0) ? position.entryPriceSol : null),
      lastValidPriceUsd: (Number.isFinite(position.currentPriceUsd) && position.currentPriceUsd > 0)
        ? position.currentPriceUsd
        : ((Number.isFinite(position.entryPriceUsd) && position.entryPriceUsd > 0) ? position.entryPriceUsd : null),
      lastValidAt: now,
      quarantine: null
    };
    if (!st) {
      st = freshSeed;
      state.mints[mint] = st;
      markDirty();
    } else if (!preserve) {
      // A NEW trade on this mint resets the accounting baseline to the entry
      // price and drops any stale quarantine from a previous position.
      st.symbol = position.symbol || st.symbol;
      st.pairAddress = position.pairAddress || st.pairAddress;
      st.dex = position.dex || st.dex;
      st.source = position.priceSource || st.source;
      st.lastValidPriceSol = freshSeed.lastValidPriceSol;
      st.lastValidPriceUsd = freshSeed.lastValidPriceUsd;
      st.lastValidAt = now;
      st.quarantine = null;
      markDirty();
    }
    return st;
  }

  /** Accept an observation as the new last-valid price for the position. */
  function acceptObservation(st, observation, now) {
    st.lastValidPriceSol = observation.priceSol;
    st.lastValidPriceUsd = observation.priceUsd;
    st.lastValidAt = now;
    if (observation.source) st.source = observation.source;
    if (observation.pairAddress) st.pairAddress = observation.pairAddress;
    if (observation.dex) st.dex = observation.dex;
    st.quarantine = null;
    markDirty();
  }

  const manager = {
    /** Anchor a freshly opened (or, on restart, already-open) position. */
    notePositionOpened(position, opts = {}) {
      try {
        mintState(position, Date.now(), !!opts.preserve);
      } catch (_) { /* diagnostics must never crash the agent */ }
      return manager;
    },

    /**
     * Decide whether an observation for an open position may be used for
     * accounting. Returns:
     *   { status: 'accepted' | 'confirmed', reason? }   → may update + run SL/TP
     *   { status: 'rejected', reason, detail? }         → NO SELL, invalid data
     *   { status: 'suspicious', reason }                → first extreme flag
     *   { status: 'quarantined', reason }               → waiting for confirmation
     */
    checkPositionObservation({ position, observation, now, independent }) {
      const ts = now != null ? now : Date.now();
      state.lastCheckAt = ts;
      if (!position || !position.mint || !observation || typeof observation !== 'object') {
        return { status: 'rejected', reason: 'INVALID_OBSERVATION' };
      }
      const st = mintState(position, ts, true);
      if (!st) return { status: 'rejected', reason: 'INVALID_OBSERVATION' };
      const symbol = position.symbol || st.symbol || null;
      const mint = position.mint;
      // The caller fetched this observation BY position.mint, so the row is
      // bound to that mint here (observations carry no mint field themselves).
      const obs = Object.assign({}, observation, { mint });

      // 1 — identity / source / validity / divergence gate (Requirement 2).
      const check = validatePositionPrice({
        position: Object.assign({}, position, { pairAddress: st.pairAddress || position.pairAddress }),
        observation: obs,
        opts: { maxAgeMs, now: ts, knownSources, maxDivergencePct, independent }
      });
      if (!check.ok) {
        const reason = check.reason;
        // Each incident logs ONE throttled [PRICE-INTEGRITY] line and advances
        // exactly one counter. Repeated identical rejections every cycle are
        // suppressed by LOG_THROTTLE_MS (no log spam) and counted once.
        const incident = reason === 'PAIR_CHANGED'
          ? { reason, detail: check.detail, counter: 'pairChangesDetected' }
          : reason === 'SOURCE_DIVERGENCE'
            ? { reason, detail: check.detail, counter: 'sourceDivergenceEvents' }
            : { reason: 'REJECTED', detail: `${reason} ${check.detail || ''}`.trim(), counter: 'rejectedObservations' };
        recordIncident(Object.assign({ symbol, mint, warning: true }, incident));
        if (st.quarantine) { st.quarantine = null; markDirty(); } // anchor identity no longer observed
        persist();
        return { status: 'rejected', reason, detail: check.detail };
      }

      // 2 — previous VALID price vs observed: extreme single-step?
      const prev = st.lastValidPriceSol;
      const move = detectSuspiciousPriceMove(prev, obs.priceSol, { extremeMovePct });

      if (!move.suspicious) {
        // Normal observation (or the market snapped back toward the last valid
        // level). Any in-flight quarantine is resolved: accounting resumes.
        if (st.quarantine) {
          recordIncident({ symbol, mint, reason: 'SNAP_BACK', detail: `price returned to last valid level (change ${move.changePct}%)` });
        }
        acceptObservation(st, obs, ts);
        persist();
        return { status: 'accepted', reason: null };
      }

      // 3 — suspicious move: flag + require confirmation (Requirement 3/8).
      // Fast-confirm: an ADVERSE extreme (long-only book: down past the gap
      // threshold) needs ONE consistent print instead of the full count — a
      // real gap exits a cycle earlier, while a single anomalous print still
      // never sells (the next normal print snaps back and resolves). Favorable
      // extremes keep full confirmations (never chase a one-print spike).
      const detail = `previous=${st.lastValidPriceSol} observed=${obs.priceSol} change=${move.changePct}%`;
      const adverseGap = move.changePct != null && move.changePct <= -Math.abs(gapKillPct);
      const required = adverseGap ? 1 : confirmationsRequired;
      if (!st.quarantine) {
        st.quarantine = {
          since: ts,
          symbol,
          baselineSol: st.lastValidPriceSol,
          baselineUsd: st.lastValidPriceUsd,
          firstObservedSol: obs.priceSol,
          firstObservedUsd: obs.priceUsd,
          direction: move.changePct > 0 ? 'up' : 'down',
          confirmations: 0,
          required,
          lastObservedAt: ts
        };
        recordIncident({ symbol, mint, reason: 'EXTREME_PRICE_MOVE', detail, counter: 'suspiciousObservations', warning: true });
        recordIncident({ symbol, mint, reason: 'WAIT_FOR_CONFIRMATION', detail: `confirmations=0/${required} — holding at last valid price` });
        markDirty();
        persist();
        return { status: 'suspicious', reason: 'EXTREME_PRICE_MOVE', quarantine: true };
      }

      // Already quarantined: does the market stay on the far side (same
      // direction)? Then it is a genuine move and confirmation accumulates.
      const q = st.quarantine;
      const sameDirection = move.changePct > 0 ? q.direction === 'up' : q.direction === 'down';
      if (!sameDirection) {
        persist();
        return { status: 'quarantined', reason: 'WAIT_FOR_CONFIRMATION', quarantine: true };
      }
      q.confirmations += 1;
      q.lastObservedAt = ts;
      markDirty();
      if (q.confirmations >= q.required) {
        acceptObservation(st, obs, ts);
        recordIncident({ symbol, mint, reason: 'ACCEPTED_AFTER_CONFIRMATION', detail: `${detail} (${q.confirmations}/${q.required} consistent observations)` });
        persist();
        return { status: 'confirmed', reason: 'ACCEPTED_AFTER_CONFIRMATION', quarantine: false };
      }
      persist();
      return { status: 'quarantined', reason: 'WAIT_FOR_CONFIRMATION', quarantine: true, confirmations: q.confirmations, required: q.required };
    },

    /** Position closed → drop its live anchor/quarantine (history is kept). */
    notePositionClosed(mint) {
      try {
        if (mint && state.mints[mint]) {
          delete state.mints[mint];
          markDirty();
        }
      } catch (_) { /* best effort */ }
      return manager;
    },

    /** Last VALID priceSol anchor for a mint (gap-kill baseline, read-only). */
    lastValidPrice(mint) {
      try {
        const st = mint && state.mints[mint];
        if (st && Number.isFinite(st.lastValidPriceSol) && st.lastValidPriceSol > 0) {
          return { priceSol: st.lastValidPriceSol, priceUsd: st.lastValidPriceUsd || null, at: st.lastValidAt || null };
        }
      } catch (_) { /* best effort */ }
      return null;
    },

    /**
     * Force-accept a validity-passed observation as the new last-valid price
     * (gap-kill path). Clears any quarantine and records a GAP_KILL_ACCEPTED
     * event so the ledger exit price and the integrity anchor stay consistent.
     * Call ONLY after validatePositionPrice passed — never on bad identity.
     */
    forceAccept(mint, observation, reason) {
      try {
        if (!mint || !observation || typeof observation !== 'object') return manager;
        let st = state.mints[mint];
        if (!st) st = state.mints[mint] = { symbol: null, quarantine: null };
        st.lastValidPriceSol = observation.priceSol;
        st.lastValidPriceUsd = observation.priceUsd;
        st.lastValidAt = Date.now();
        if (observation.source) st.source = observation.source;
        if (observation.pairAddress) st.pairAddress = observation.pairAddress;
        if (observation.dex) st.dex = observation.dex;
        st.quarantine = null;
        markDirty();
        recordIncident({
          symbol: st.symbol || null, mint,
          reason: 'GAP_KILL_ACCEPTED',
          detail: `${reason || 'gap-kill'} priceSol=${observation.priceSol}`,
          counter: null, warning: false
        });
        persist();
      } catch (_) { /* diagnostics must never crash the agent */ }
      return manager;
    },

    /** Count a source-divergence rejection reported by the market-data layer. */
    noteSourceDivergence(rawMsg) {
      const detail = typeof rawMsg === 'string' ? rawMsg : 'price divergence detected';
      recordIncident({ symbol: null, mint: null, reason: 'SOURCE_DIVERGENCE', detail, counter: 'sourceDivergenceEvents', warning: true });
      persist();
      return manager;
    },

    /** Read-only snapshot for heartbeat / dashboard. */
    snapshot() {
      return summarize(state);
    },

    persist,
    state: () => state
  };

  return manager;
}

module.exports = {
  createPriceIntegrity,
  validateMarketObservation,
  detectPairChange,
  detectSuspiciousPriceMove,
  detectGapKill,
  comparePriceSources,
  validatePositionPrice,
  summarize,
  FILE_NAME,
  KNOWN_SOURCES,
  DEFAULT_EXTREME_MOVE_PCT,
  DEFAULT_CONFIRMATIONS_REQUIRED,
  DEFAULT_GAP_KILL_PCT,
  DEFAULT_LIQ_DROP_PCT,
  LOG_THROTTLE_MS
};
