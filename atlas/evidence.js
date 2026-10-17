#!/usr/bin/env node
/**
 * atlas/evidence.js — evidence + dataQuality scoring.
 *
 * Every ATLAS decision carries an evidence list and a dataQualityScore [0, 100].
 * Evidence entries are structured, timestamped, sourced, and confidence-scored.
 *
 * Data quality combines:
 *   - freshness
 *   - source reliability
 *   - pair identity stability
 *   - cross-source agreement
 *   - completeness
 *   - timestamp validity
 *
 * Invalid/quarantined -> 0. ATLAS never compensates for bad data with high confidence.
 */

'use strict';

/** Canonical evidence entry. */
function evidenceEntry(claim, value, source, confidence, extra = {}) {
  return {
    claim: String(claim),
    value: value,
    source: String(source),
    confidence: Math.max(0, Math.min(100, Number.isFinite(confidence) ? confidence : 0)),
    timestamp: Date.now(),
    ...extra
  };
}

/**
 * Compute a dataQualityScore [0, 100] from the available integrity/market facts.
 * This is deliberately conservative and does NOT invent any data.
 */
function dataQuality(integrity, market, freshnessMs, maxFreshMs, opts = {}) {
  const reasons = integrity && integrity.reasons ? integrity.reasons : [];
  const dataQualityStatus = integrity && integrity.dataQuality ? integrity.dataQuality : 'ok';

  // Quarantined / invalid -> 0
  if (dataQualityStatus === 'suspicious' || dataQualityStatus === 'fail' || dataQualityStatus === 'quarantined') {
    return { score: 0, reasons: ['dataIntegrity: ' + dataQualityStatus] };
  }

  let score = 0;
  const flags = [];

  // pair stability
  if (integrity && integrity.pairStable === true) score += 25;
  else if (integrity && integrity.pairStable === false) { score += 0; flags.push('pair_unstable'); }
  else score += 12; // unknown

  // source agreement
  if (integrity && integrity.sourcesAgree === true) score += 25;
  else if (integrity && integrity.sourcesAgree === false) { score += 0; flags.push('source_divergence'); }
  else score += 12;

  // freshness
  if (Number.isFinite(freshnessMs)) {
    if (freshnessMs <= maxFreshMs) score += 25;
    else score += Math.max(0, 25 - (freshnessMs - maxFreshMs) / maxFreshMs * 25);
  } else {
    score += 5;
    flags.push('freshness_unknown');
  }

  // completeness — minimal: priceUsd, priceSol, pairAddress, dex
  const cand = opts.candidate || {};
  let complete = 0;
  if (Number.isFinite(cand.priceUsd)) complete += 1;
  if (Number.isFinite(cand.priceSol)) complete += 1;
  if (cand.pairAddress != null) complete += 1;
  if (cand.dex != null) complete += 1;
  score += (complete / 4) * 15;

  // market regime known
  if (market && market.regime) score += 10;
  else score += 2;

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    reasons: flags
  };
}

module.exports = { evidenceEntry, dataQuality };
