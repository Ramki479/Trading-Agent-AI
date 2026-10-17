#!/usr/bin/env node
/**
 * atlas/stage-pipeline.js — ATLAS staged intelligence pipeline.
 *
 * Stages:
 *   Stage 1: all candidates → deterministic filtering
 *   Stage 2: top 10 → lightweight ATLAS scoring (deterministic specialists)
 *   Stage 3: top 5 → deep specialist analysis (all deterministic + LLM where enabled)
 *   Stage 4: top 3 → Bull/Bear/Risk debate (LLM where enabled)
 *   Stage 5: top 1-3 → final ATLAS synthesis (LLM where enabled)
 *   Stage 6: existing V1 authorization (authoritative)
 *
 * Reduces API cost, latency, noise, correlated opinions, and hallucination exposure.
 * Uses caching keyed by mint + pairAddress + dex + timestamp bucket.
 */

'use strict';

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));

const DEFAULT_MAX_CANDIDATES = 5;
const DEFAULT_CACHE_TTL_MS = 60000;
const TS_BUCKET_MS = 60000; // cache key granularity

/** Score a candidate with deterministic specialists only (no LLM). */
function lightweightScore(candidate, specialistOutputs) {
  const parts = [];
  if (specialistOutputs.technical && specialistOutputs.technical.score != null) parts.push(specialistOutputs.technical.score);
  if (specialistOutputs.momentum && specialistOutputs.momentum.score != null) parts.push(specialistOutputs.momentum.score);
  if (specialistOutputs.volatility && specialistOutputs.volatility.score != null) parts.push(specialistOutputs.volatility.score);
  if (specialistOutputs.liquidity && specialistOutputs.liquidity.liquidityScore != null) parts.push(specialistOutputs.liquidity.liquidityScore);
  if (specialistOutputs.regime && specialistOutputs.regime.score != null) parts.push(specialistOutputs.regime.score);
  if (specialistOutputs.tokenQuality && specialistOutputs.tokenQuality.tokenQualityScore != null) parts.push(specialistOutputs.tokenQuality.tokenQualityScore);
  if (!parts.length) return { score: 0, components: {} };
  const avg = parts.reduce((a, b) => a + b, 0) / parts.length;
  return {
    score: clamp(Math.round(avg)),
    components: {
      technical: specialistOutputs.technical && specialistOutputs.technical.score,
      momentum: specialistOutputs.momentum && specialistOutputs.momentum.score,
      volatility: specialistOutputs.volatility && specialistOutputs.volatility.score,
      liquidity: specialistOutputs.liquidity && specialistOutputs.liquidity.liquidityScore,
      regime: specialistOutputs.regime && specialistOutputs.regime.score,
      tokenQuality: specialistOutputs.tokenQuality && specialistOutputs.tokenQuality.tokenQualityScore
    }
  };
}

/** Cache key for a candidate observation. */
function cacheKey(type, mint, pairAddress, dex, ts) {
  const bucket = Math.floor(ts / TS_BUCKET_MS) * TS_BUCKET_MS;
  const pair = pairAddress || '';
  const dexx = dex || '';
  return type + '|' + mint + '|' + pair + '|' + dexx + '|' + bucket;
}

/** Rank candidates by (deterministic score desc, then V1 score desc). */
function rank(candidates, scores) {
  const withScore = candidates.map(c => {
    const key = cacheKey('candidate', c.mint, c.pairAddress, c.dex, c.ts || Date.now());
    return {
      candidate: c,
      score: scores[key] != null ? scores[key] : 0,
      v1Score: Number.isFinite(c.score) ? c.score : 0,
      key
    };
  });
  withScore.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.v1Score !== a.v1Score) return b.v1Score - a.v1Score;
    return (a.candidate.symbol || '').localeCompare(b.candidate.symbol || '');
  });
  return withScore;
}

/** Filter out integrity-failed candidates. */
function integrityFilter(candidates, integritySnap, opts = {}) {
  if (!integritySnap) return candidates;
  const out = [];
  for (const c of candidates) {
    const i = opts.integrityFor ? opts.integrityFor(integritySnap, c.mint) : integrityFor(integritySnap, c.mint);
    if (i.dataQuality === 'suspicious' || i.dataQuality === 'fail' || i.dataQuality === 'quarantined') {
      c._integrityBlocked = true;
      c._integrityDataQuality = i.dataQuality;
      c._integrityReasons = i.reasons;
      continue;
    }
    out.push(c);
  }
  return out;
}

function integrityFor(snapshot, mint) {
  if (!snapshot || !mint) return { dataQuality: 'ok', reasons: [], quarantined: false };
  const q = Array.isArray(snapshot.quarantined) ? snapshot.quarantined.find(x => x && x.mint === mint) : null;
  const reasons = [];
  if (q) reasons.push('suspicious:EXTREME_PRICE_MOVE quarantine');
  const lw = snapshot.lastWarning;
  if (lw && lw.mint === mint && lw.reason) reasons.push(String(lw.reason));
  const dataQuality = (q || (lw && lw.mint === mint)) ? 'suspicious' : 'ok';
  return { dataQuality, reasons, quarantined: !!q };
}

module.exports = {
  DEFAULT_MAX_CANDIDATES,
  DEFAULT_CACHE_TTL_MS,
  TS_BUCKET_MS,
  cacheKey,
  lightweightScore,
  rank,
  integrityFilter,
  integrityFor
};
