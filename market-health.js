#!/usr/bin/env node
/**
 * market-health.js — PAPER-ONLY market/network health gate.
 *
 * Upstream Circuit (Tier 3) gates entries on on-chain ecosystem health (TPS,
 * validators, priority fees) from paid Circuit infrastructure. This paper
 * agent has no such feed, so we implement a FREE-DATA equivalent from the
 * real observable signals the agent already collects (documented as OUR
 * IMPLEMENTATION in docs/CIRCUIT_CURRENT_RESEARCH.md — never presented as
 * upstream behavior):
 *
 *   - price-source status    (primary provider errors → health down)
 *   - SOL price freshness    (stale SOL/USD → health down)
 *   - discovery feed health  (feed failures → health down)
 *   - scan output quality    (candidates lacking real liquidity/volume → health down)
 *
 * The gate may only REDUCE or BLOCK new paper entries. It NEVER touches
 * safety exits (stop-loss / take-profit monitoring runs unconditionally).
 * Fail-open: missing/unreadable inputs → healthy (1.0), matching upstream's
 * fail-open behavior.
 */

'use strict';

function num(v) {
  return Number.isFinite(Number(v)) ? Number(v) : null;
}

/**
 * @param {object} input
 *   sourceStats:  [{ name, status: 'ok'|'error'|'unknown', lastOkAt, lastError }]
 *   solPriceAgeMs: age of the last real SOL/USD price (ms)
 *   solPriceMaxAgeMs: staleness threshold (default 120000)
 *   discoveryFailures: consecutive discovery scan failures in a row
 *   lastScanQuality:  { candidates, withLiquidity } from the last scan
 *   cfg: { minHealthScore, solPriceMaxAgeMs }
 * @returns {{ score, status, reason, gate, sizeMultiplier }}
 *   score 0..100 (100 = healthy), gate true = block new entries,
 *   sizeMultiplier 0..1 to shrink entry size (never grows).
 */
function computeHealth(input = {}) {
  const cfg = input.cfg || {};
  const sources = Array.isArray(input.sourceStats) ? input.sourceStats : [];
  const solAge = num(input.solPriceAgeMs);
  const solMaxAge = num(input.solPriceMaxAgeMs) || cfg.solPriceMaxAgeMs || 120000;
  const discFailures = num(input.discoveryFailures) || 0;

  const penalties = [];
  let score = 100;

  // 1. Primary price source errors (weight: 30).
  const errored = sources.filter((s) => s && s.status === 'error');
  if (errored.length) {
    score -= Math.min(30, errored.length * 15);
    penalties.push(`${errored.length} price source(s) in error`);
  }
  const neverOk = sources.filter((s) => s && s.status !== 'ok' && !s.lastOkAt);
  if (neverOk.length && !sources.length) {
    // No source has EVER succeeded → we are flying blind.
    score -= 30;
    penalties.push('no price source has succeeded yet');
  }

  // 2. SOL price freshness (weight: 25).
  if (solAge != null && solAge > solMaxAge) {
    score -= 25;
    penalties.push(`SOL price stale (${Math.round(solAge / 1000)}s > ${Math.round(solMaxAge / 1000)}s)`);
  }

  // 3. Discovery feed health (weight: 25) — repeated total failures.
  if (discFailures >= 3) {
    score -= Math.min(25, discFailures * 8);
    penalties.push(`${discFailures} consecutive discovery failures`);
  }

  // 4. Scan quality — candidates that are real but lack usable liquidity (weight: 20).
  const q = input.lastScanQuality;
  if (q && num(q.candidates) > 0) {
    const withLiq = num(q.withLiquidity);
    const ratio = withLiq != null ? withLiq / q.candidates : 1;
    if (ratio < 0.5) {
      score -= Math.round((1 - ratio) * 20);
      penalties.push('scan candidates mostly lack real liquidity');
    }
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const minHealth = num(cfg.minHealthScore) || 60;
  const gate = score < minHealth;
  const sizeMultiplier = gate ? 0 : Math.max(0.5, score / 100); // scale down only

  const status = gate ? 'GATED' : score < 90 ? 'DEGRADED' : 'HEALTHY';
  return {
    score,
    status,
    reason: penalties.length ? penalties.join(' | ') : 'healthy',
    gate,
    sizeMultiplier,
    components: { priceSources: sources.length, solPriceAgeMs: solAge, discoveryFailures: discFailures }
  };
}

module.exports = { computeHealth };