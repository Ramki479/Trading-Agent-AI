#!/usr/bin/env node
/**
 * atlas/dataset-hash.js — Deterministic dataset hashing and analysis versioning.
 *
 * Hashes the exact matched observation set used for each analysis.
 * Every analysis must have:
 *   analysisId, analysisVersion, datasetHash, codeVersion, timestamp
 *
 * Different methodology versions must produce different analysis versions.
 */

'use strict';

const crypto = require('crypto');

const CODE_VERSION = 'ATLAS-0.2.0';

/**
 * Compute a deterministic hash of a matched observation set.
 * @param matchedSamples — array of matched observation objects
 * @returns hex hash string
 */
function computeDatasetHash(matchedSamples) {
  if (!Array.isArray(matchedSamples) || matchedSamples.length === 0) {
    return 'EMPTY';
  }

  // Sort by predictionId for determinism
  const sorted = matchedSamples
    .slice()
    .sort((a, b) => (a.predictionId || '').localeCompare(b.predictionId || ''));

  // Build canonical string
  const parts = sorted.map(m => {
    return [
      m.predictionId || '',
      m.mint || '',
      m.predictionTimestamp || 0,
      m.circuitReturn || 0,
      m.atlasReturn || 0,
      m.agent || '',
      m.direction || '',
      m.dataQuality || ''
    ].join('|');
  });

  const canonical = parts.join(';;');
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * Create an analysis version record.
 * @param matchedSamples — the matched observations used
 * @param opts — { methodology, description }
 * @returns analysis version object
 */
function createAnalysisVersion(matchedSamples, opts = {}) {
  return {
    analysisId: 'AV-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase(),
    analysisVersion: opts.version || '1.0.0',
    codeVersion: CODE_VERSION,
    methodology: opts.methodology || 'default',
    description: opts.description || null,
    datasetHash: computeDatasetHash(matchedSamples),
    sampleCount: matchedSamples ? matchedSamples.length : 0,
    timestamp: Date.now(),
    iso: new Date().toISOString()
  };
}

/**
 * Persist an analysis version.
 */
function persistAnalysisVersion(db, version) {
  try {
    const existing = db.readJson ? db.readJson('atlas-analysis-versions.json') : null;
    const versions = (existing && existing.versions) ? existing.versions : [];
    versions.push(version);
    // Keep last 50 versions
    if (versions.length > 50) versions.splice(0, versions.length - 50);
    if (db.writeJson) db.writeJson('atlas-analysis-versions.json', { versions, updatedAt: Date.now() });
  } catch (_) { /* best effort */ }
}

/**
 * Get all analysis versions.
 */
function getAnalysisVersions(db) {
  try {
    const existing = db.readJson ? db.readJson('atlas-analysis-versions.json') : null;
    return (existing && existing.versions) ? existing.versions : [];
  } catch (_) { return []; }
}

module.exports = { computeDatasetHash, createAnalysisVersion, persistAnalysisVersion, getAnalysisVersions, CODE_VERSION };
