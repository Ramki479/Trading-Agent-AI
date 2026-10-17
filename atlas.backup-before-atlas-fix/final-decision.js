#!/usr/bin/env node
/**
 * atlas/final-decision.js — Final decision engine for Phase 15.
 *
 * Consumes the consolidated evidence and produces a deterministic
 * final classification with human decision firewall.
 *
 * Usage: node atlas/final-decision.js [--data-dir <path>]
 */

'use strict';

const crypto = require('crypto');
const { consolidate, classifyFinal } = require('./evidence-consolidator.js');

const REVIEW_DIR = 'atlas/reviews';

function sha256Hex(data) { return crypto.createHash('sha256').update(typeof data === 'string' ? data : JSON.stringify(data)).digest('hex'); }
function deterministicDecisionId(datasetHash, classification) { return 'FINAL-' + sha256Hex(`hash=${datasetHash}&class=${classification}`).slice(0, 12).toUpperCase(); }

function decide(dataDir) {
  const evidence = consolidate(dataDir);
  if (evidence.status !== 'CONSOLIDATED') {
    return { decisionId: deterministicDecisionId('NONE', 'INSUFFICIENT_EVIDENCE'), status: 'INSUFFICIENT_EVIDENCE', classification: 'INSUFFICIENT_EVIDENCE', humanDecisionRequired: true, automaticallyPromoted: false, recommendation: 'CONTINUE_SHADOW' };
  }

  const decisionId = deterministicDecisionId(evidence.datasetHash, evidence.classification);

  const possibleDecisions = ['CONTINUE_SHADOW', 'ACCEPT_ATLAS_FOR_FURTHER_REVIEW', 'REJECT_ATLAS', 'REQUEST_MORE_DATA', 'APPROVE_PRODUCTION_READINESS_REVIEW'];

  let recommendation;
  switch (evidence.classification) {
    case 'ATLAS_SUPPORTED_FOR_REVIEW': recommendation = 'ACCEPT_ATLAS_FOR_FURTHER_REVIEW'; break;
    case 'ATLAS_PARTIALLY_SUPPORTED': recommendation = 'REQUEST_MORE_DATA'; break;
    case 'NEGATIVE': recommendation = 'REJECT_ATLAS'; break;
    case 'INCONCLUSIVE': recommendation = 'REQUEST_MORE_DATA'; break;
    case 'INTEGRITY_FAILURE': recommendation = 'REJECT_ATLAS'; break;
    default: recommendation = 'CONTINUE_SHADOW'; break;
  }

  return {
    decisionId, phase: 15, status: evidence.classification, evidenceClassification: evidence.classification,
    datasetHash: evidence.datasetHash,
    sampleCount: evidence.sampleCount,
    recommendation, humanDecisionRequired: true, automaticallyPromoted: false,
    possibleDecisions,
    note: 'Human review is mandatory. ATLAS remains SHADOW regardless of evidence classification.',
    createdAt: Date.now()
  };
}

function persistDecision(dataDir, decisionResult) {
  try {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(dataDir, REVIEW_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'final-human-decision.json'), JSON.stringify(decisionResult, null, 2) + '\n');
    return true;
  } catch (_) { return false; }
}

function main(args) {
  const dataDir = args.includes('--data-dir') ? args[args.indexOf('--data-dir') + 1] : process.cwd();
  const result = decide(dataDir);
  console.log('FINAL DECISION');
  console.log('Decision ID:', result.decisionId);
  console.log('Classification:', result.evidenceClassification);
  console.log('Recommendation:', result.recommendation);
  console.log('Human Required:', result.humanDecisionRequired);
  console.log('Auto Promoted:', result.automaticallyPromoted);
  console.log('ATLAS: SHADOW | Circuit: AUTHORITATIVE | Execution: PAPER ONLY');
  persistDecision(dataDir, result);
  process.exit(0);
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { decide, persistDecision };
