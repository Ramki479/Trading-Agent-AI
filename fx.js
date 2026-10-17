#!/usr/bin/env node
/**
 * fx.js — USD ⇄ INR exchange-rate helper for the read-only dashboard API.
 *
 * This module is DISPLAY-ONLY. It is never used by the trading engine
 * (agentd.js) and never affects portfolio accounting, trade sizing,
 * stop-loss/take-profit or any strategy decision. All trading math stays in
 * SOL; INR values are a presentation layer derived from:
 *
 *     inrPerSol = solPriceUsd × usdInr
 *     inrValue  = solValue  × inrPerSol      (SOL → INR, via real SOL/USD)
 *     inrValue  = usdValue  × usdInr         (USD → INR, direct)
 *
 * Where:
 *   - solPriceUsd comes from the REAL SOL/USD price the market-data provider
 *     already obtained (read from the agent heartbeat, never fetched twice).
 *   - usdInr comes from live keyless sources tried in order
 *     (open.er-api.com, then frankfurter.app, then frankfurter.dev). The
 *     last valid rate is cached on disk (${CIRCUIT_AGENT_DATA_DIR}/
 *     fx-rate-cache.json) so a provider outage keeps showing the last real
 *     rate, clearly flagged `cached: true`. Failed refreshes retry after
 *     ~60 s instead of waiting a full refresh cycle.
 *
 * Never a fake, random, or hard-coded rate.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 8000;

/** Live USD→INR sources (keyless). Tried in order; first success wins.
 * Three independent hosts so a single provider/CDN outage never kills the
 * rate: open.er-api.com (aggregated), frankfurter.app + frankfurter.dev
 * (ECB daily reference rates, two hostnames). */
const USD_INR_SOURCES = [
  {
    name: 'open.er-api.com',
    url: 'https://open.er-api.com/v6/latest/USD',
    parse: (j) => (j && j.result === 'success' && j.rates && Number(j.rates.INR) > 0
      ? Number(j.rates.INR)
      : null)
  },
  {
    name: 'frankfurter.app',
    url: 'https://api.frankfurter.app/latest?from=USD&to=INR',
    parse: (j) => (j && j.rates && Number(j.rates.INR) > 0 ? Number(j.rates.INR) : null)
  },
  {
    name: 'frankfurter.dev',
    url: 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=INR',
    parse: (j) => (j && j.rates && Number(j.rates.INR) > 0 ? Number(j.rates.INR) : null)
  }
];

function round(n, d = 8) {
  if (!Number.isFinite(n)) return 0;
  const p = Math.pow(10, d);
  return Math.round((n + Number.EPSILON) * p) / p;
}

/* ------------------------------------------------------------------ *
 * Conversions (pure — easy to unit test).
 * ------------------------------------------------------------------ */

/** 1 SOL in INR = solUsd × usdInr. */
function inrPerSolOf(solPriceUsd, usdInr) {
  if (!(Number(solPriceUsd) > 0) || !(Number(usdInr) > 0)) return null;
  return Number(solPriceUsd) * Number(usdInr);
}

/** USD → INR. */
function inrFromUsd(usd, usdInr) {
  if (!Number.isFinite(usd) || !(Number(usdInr) > 0)) return null;
  return usd * Number(usdInr);
}

/** SOL → INR (uses the real SOL/USD price baked into inrPerSol). */
function inrFromSol(sol, inrPerSolValue) {
  if (!Number.isFinite(sol) || !(Number(inrPerSolValue) > 0)) return null;
  return sol * inrPerSolValue;
}

/* ------------------------------------------------------------------ *
 * Indian number formatting.
 * ------------------------------------------------------------------ */

/** Group an integer digit string in Indian style: 1234567 → 12,34,567. */
function groupIndian(intStr) {
  if (intStr.length <= 3) return intStr;
  const last3 = intStr.slice(-3);
  let rest = intStr.slice(0, -3);
  const parts = [];
  while (rest.length > 2) {
    parts.unshift(rest.slice(-2));
    rest = rest.slice(0, -2);
  }
  if (rest.length) parts.unshift(rest);
  parts.push(last3);
  return parts.join(',');
}

/**
 * Format a number as Indian-style INR, e.g. ₹1,234.56 / ₹1,00,000.00.
 * `frac` decimals are used; leading zeros are trimmed for very small values
 * only if `trim` is set (for token prices).
 */
function formatInr(value, frac = 2, trim = false) {
  if (!Number.isFinite(value)) return '—';
  const neg = value < 0;
  let fixed = Math.abs(value).toFixed(frac);
  if (trim && Math.abs(value) > 0 && Math.abs(value) < 1) {
    // keep significant digits instead of 0.00 for tiny token prices
    fixed = Math.abs(value).toFixed(8).replace(/0+$/, '');
  }
  const dot = fixed.indexOf('.');
  const intStr = dot >= 0 ? fixed.slice(0, dot) : fixed;
  const dec = dot >= 0 ? fixed.slice(dot) : '';
  return '₹' + (neg ? '-' : '') + groupIndian(intStr) + dec;
}

/** Same as formatInr but with an explicit + sign for positive P&L values. */
function signedInr(value, frac = 2) {
  if (!Number.isFinite(value)) return '—';
  return (value >= 0 ? '+' : '') + formatInr(value, frac);
}

/* ------------------------------------------------------------------ *
 * Live rate fetch + cached manager.
 * ------------------------------------------------------------------ */

async function fetchJson(url, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => ctrl && ctrl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url, { signal: ctrl ? ctrl.signal : undefined });
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Try each live source in order. Resolves { usdInr, source, fetchedAt } or
 * rejects with the last error when every source fails.
 */
async function fetchUsdInr(opts = {}) {
  const errors = [];
  for (const src of USD_INR_SOURCES) {
    try {
      const json = await fetchJson(src.url, opts);
      const rate = src.parse(json);
      if (!(rate > 0)) throw new Error(`unparseable rate from ${src.name}`);
      return { usdInr: rate, source: src.name, fetchedAt: Date.now() };
    } catch (err) {
      errors.push(`${src.name}: ${err.message}`);
    }
  }
  throw new Error('all USD/INR sources failed — ' + errors.join(' | '));
}

/**
 * FxManager keeps the last valid real rate in memory + on disk, refreshes it
 * in the background, and always reports whether the value is `cached` (i.e.
 * served from the last valid fetch rather than a fresh network success).
 */
function createFxManager({ cacheFile, fetchImpl, refreshMs = 5 * 60 * 1000, failureRetryMs = 60 * 1000 } = {}) {
  let state = null;      // { usdInr, source, fetchedAt, cached }
  let lastError = null;
  let lastTryAt = 0;
  let timer = null;
  let started = false;

  function loadCache() {
    if (!cacheFile) return null;
    try {
      if (!fs.existsSync(cacheFile)) return null;
      const j = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (j && Number(j.usdInr) > 0 && j.source && Number(j.fetchedAt) > 0) {
        return { usdInr: Number(j.usdInr), source: String(j.source), fetchedAt: Number(j.fetchedAt), cached: true };
      }
    } catch (_) { /* corrupt cache → ignore */ }
    return null;
  }

  function saveCache() {
    if (!cacheFile || !state) return;
    try {
      const tmp = cacheFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ usdInr: state.usdInr, source: state.source, fetchedAt: state.fetchedAt }) + '\n');
      fs.renameSync(tmp, cacheFile);
    } catch (_) { /* cache is best-effort — memory copy still works */ }
  }

  function setFresh(usdInr, source) {
    state = { usdInr, source, fetchedAt: Date.now(), cached: false };
    saveCache();
  }

  /** Try to refresh from the live sources. Never throws. */
  async function refresh() {
    lastTryAt = Date.now();
    try {
      const r = await fetchUsdInr({ fetchImpl });
      setFresh(r.usdInr, r.source);
      lastError = null;
    } catch (err) {
      lastError = err.message;
      // keep the last valid rate (state unchanged) — still flagged cached
      if (!state) state = loadCache();
    }
    return current();
  }

  /** Synchronous snapshot for request handlers. */
  function current() {
    if (!state) state = loadCache();
    if (!state) return null;
    return { usdInr: state.usdInr, source: state.source, fetchedAt: state.fetchedAt, cached: state.cached };
  }

  /** Adaptive background loop: after a failure retry soon (failureRetryMs),
   *  otherwise refresh on refreshMs. Never overlaps two refreshes. */
  function schedule() {
    if (!started) return;
    const delay = lastError ? failureRetryMs : refreshMs;
    timer = setTimeout(() => {
      timer = null;
      refresh().catch(() => {}).then(() => schedule());
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function start() {
    if (started) return;
    started = true;
    if (refreshMs > 0) schedule();
  }

  function stop() {
    started = false;
    if (timer) { clearTimeout(timer); timer = null; }
  }

  return {
    refresh,
    current,
    start,
    stop,
    get lastError() { return lastError; },
    get lastTryAt() { return lastTryAt; }
  };
}

module.exports = {
  USD_INR_SOURCES,
  round,
  inrPerSolOf,
  inrFromUsd,
  inrFromSol,
  groupIndian,
  formatInr,
  signedInr,
  fetchUsdInr,
  createFxManager
};
