#!/usr/bin/env node
/**
 * atlas/promotion-request.js — Manual promotion request system.
 *
 * Promotion requests must be:
 *   - manual
 *   - explicit
 *   - auditable
 *
 * Creating a request must NOT change ATLAS mode.
 * Default: approved = false.
 */

'use strict';

/**
 * Create a new promotion request.
 * @param db — AtlasDb instance
 * @param opts — { reason, requestedChange, requester, evidenceState, sampleSize, datasetHash, analysisVersion }
 * @returns the created request
 */
function createRequest(db, opts = {}) {
  const request = {
    requestId: 'PR-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6).toUpperCase(),
    timestamp: Date.now(),
    iso: new Date().toISOString(),
    currentEvidenceState: opts.evidenceState || 'UNKNOWN',
    sampleSize: opts.sampleSize || 0,
    datasetHash: opts.datasetHash || null,
    analysisVersion: opts.analysisVersion || null,
    reason: opts.reason || 'No reason provided',
    requestedChange: opts.requestedChange || 'ATLAS SHADOW → ADVISORY',
    requester: opts.requester || 'unknown',
    approved: false, // MUST be false by default
    approvedBy: null,
    approvedAt: null,
    denialReason: null,
    _note: 'Creating this request does NOT change ATLAS mode. Human approval is required.'
  };

  // Persist
  try {
    const existing = db.readJson ? db.readJson('atlas-promotion-requests.json') : null;
    const requests = (existing && existing.requests) ? existing.requests : [];
    requests.push(request);
    if (db.writeJson) db.writeJson('atlas-promotion-requests.json', { requests, updatedAt: Date.now() });
  } catch (_) { /* best effort */ }

  return request;
}

/**
 * Get all promotion requests.
 */
function getRequests(db) {
  try {
    const existing = db.readJson ? db.readJson('atlas-promotion-requests.json') : null;
    return (existing && existing.requests) ? existing.requests : [];
  } catch (_) { return []; }
}

/**
 * Get the latest promotion request.
 */
function getLatestRequest(db) {
  const requests = getRequests(db);
  return requests.length > 0 ? requests[requests.length - 1] : null;
}

/**
 * Hard promotion requirements assessment.
 * Returns the list of requirements and which are met.
 */
function assessRequirements(analysisResult) {
  const reqs = [];

  const n = analysisResult && analysisResult.validObservations ? analysisResult.validObservations : 0;
  const lookahead = analysisResult && analysisResult.lookaheadAudit ? analysisResult.lookaheadAudit : {};
  const dq = analysisResult && analysisResult.dataQuality ? analysisResult.dataQuality : {};
  const effect = analysisResult && analysisResult.paired && analysisResult.paired.effectSize ? analysisResult.paired.effectSize : {};
  const test = analysisResult && analysisResult.paired && analysisResult.paired.statisticalTest ? analysisResult.paired.statisticalTest : {};
  const promotion = analysisResult && analysisResult.promotion ? analysisResult.promotion : {};

  reqs.push({ name: 'minimum_sample_200', met: n >= 200, detail: `${n} matched observations` });
  reqs.push({ name: 'no_lookahead_violations', met: (lookahead.violations || 0) === 0, detail: `${lookahead.violations || 0} violations` });
  reqs.push({ name: 'acceptable_data_quality', met: (dq.qualityRate || 0) >= 80, detail: `quality rate ${dq.qualityRate || 0}%` });
  reqs.push({ name: 'statistically_evaluated', met: test && test.testName !== 'none', detail: test ? test.testName : 'no test run' });
  reqs.push({ name: 'effect_size_not_negligible', met: effect.interpretation !== 'NEGLIGIBLE' && effect.interpretation !== 'INSUFFICIENT_DATA', detail: effect.interpretation || 'unknown' });
  reqs.push({ name: 'positive_mean_difference', met: analysisResult && analysisResult.matched && analysisResult.matched.meanDifference > 0, detail: `diff=${analysisResult && analysisResult.matched ? analysisResult.matched.meanDifference : 'N/A'}` });
  reqs.push({ name: 'evidence_state_checkpoint_200', met: analysisResult && analysisResult.evidenceState === 'CHECKPOINT_200', detail: analysisResult ? analysisResult.evidenceState : 'unknown' });

  const metCount = reqs.filter(r => r.met).length;
  const totalReqs = reqs.length;

  return {
    ready: metCount === totalReqs,
    metCount,
    totalReqs,
    requirements: reqs,
    note: 'Even if all conditions pass, ATLAS remains SHADOW. Human approval is still required.'
  };
}

module.exports = { createRequest, getRequests, getLatestRequest, assessRequirements };
