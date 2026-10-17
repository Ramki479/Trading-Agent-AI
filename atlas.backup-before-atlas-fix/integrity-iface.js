#!/usr/bin/env node
/**
 * atlas/integrity-iface.js — ATLAS integrity interface.
 *
 * Reads the existing price-integrity state so ATLAS can:
 *   - refuse to research quarantined/invalid observations
 *   - report dataQuality = suspicious when a mint is quarantined
 *   - raise price_integrity_warning and PAIR_CHANGED in bear/risk
 *
 * This is a thin reader over the existing price-integrity.json in the agent data
 * directory. ATLAS NEVER duplicates price-integrity logic.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const INTEGRITY_FILE = 'price-integrity.json';

function loadIntegrity(dir) {
  if (!dir) return null;
  try {
    const f = path.join(dir, INTEGRITY_FILE);
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (_) {
    return null;
  }
}

/** Facts for a single mint from the integrity snapshot. */
function integrityFor(snapshot, mint) {
  if (!snapshot || !mint) return { dataQuality: 'ok', reasons: [], quarantined: false, pairStable: null, sourcesAgree: null, suspiciousPriceMove: false, pairChanged: false, sourceDivergence: false, stalePrice: false, invalidPrice: false };
  const q = Array.isArray(snapshot.quarantined) ? snapshot.quarantined.find(x => x && x.mint === mint) : null;
  const reasons = [];
  if (q) reasons.push('suspicious:EXTREME_PRICE_MOVE quarantine');
  const lw = snapshot.lastWarning;
  if (lw && lw.mint === mint && lw.reason) reasons.push(String(lw.reason));
  const dataQuality = (q || (lw && lw.mint === mint)) ? 'suspicious' : 'ok';
  return {
    dataQuality,
    reasons,
    quarantined: !!q,
    pairStable: q && q.pairStable != null ? q.pairStable : (snapshot.pairStable != null ? snapshot.pairStable : null),
    sourcesAgree: q && q.sourcesAgree != null ? q.sourcesAgree : (snapshot.sourcesAgree != null ? snapshot.sourcesAgree : null),
    suspiciousPriceMove: !!q && q.reason && /EXTREME_PRICE_MOVE|price_discrepancy/i.test(q.reason),
    pairChanged: reasons.some(r => /PAIR_CHANGED/i.test(r)),
    sourceDivergence: reasons.some(r => /SOURCE_DIVERGENCE|source_divergence|divergence/i.test(r)),
    stalePrice: reasons.some(r => /STALE|stale/i.test(r)),
    invalidPrice: reasons.some(r => /price unavailable|price unavailable|invalid price/i.test(r)),
    lastWarning: lw && lw.mint === mint ? lw : null
  };
}

module.exports = { loadIntegrity, integrityFor, INTEGRITY_FILE };
