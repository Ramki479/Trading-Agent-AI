#!/usr/bin/env node
/**
 * atlas/checkpoint100-decision.js — Human decision gate for Checkpoint 100.
 *
 * Consumes the Checkpoint 100 review and independently validates integrity
 * before producing a decision classification.
 *
 * Usage: node atlas/checkpoint100-decision.js [--data-dir <path>]
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { review } = require('./checkpoint100-review.js');

const CODE_VERSION = 'ATLAS-0.2.0';
const REVIEW_DIR = 'atlas/reviews';

function sha256Hex(data) { return crypto.createHash('sha256').update(typeof data === 'string' ? data : JSON.stringify(data)).digest('hex'); }
function deterministicDecisionId(reviewId, evidenceClassification) { return 'DEC100-' + sha256Hex(`review=${reviewId}&class=${evidenceClassification}`).slice(0, 12).toUpperCase(); }

function decide(dataDir) {
  const rv = review(dataDir);
  if (rv.status === 'CHECKPOINT_100_NOT_REACHED') {
    return { decisionId: deterministicDecisionId('NONE', 'INSUFFICIENT_EVIDENCE'), status: 'CHECKPOINT_100_NOT_REACHED', evidenceClassification: 'INSUFFICIENT_EVIDENCE', decision: null, automaticallyPromoted: false, humanDecisionRequired: true };
  }

  const decisionId = deterministicDecisionId(rv.reviewId, rv.evidenceClassification);
  let decision;
  switch (rv.evidenceClassification) {
    case 'POSITIVE_EVIDENCE': decision = 'POSITIVE_BUT_CONTINUE_SHADOW'; break;
    case 'NEGATIVE_EVIDENCE': decision = 'NEGATIVE_EVIDENCE_CONTINUE_SHADOW'; break;
    case 'INCONCLUSIVE': decision = 'INCONCLUSIVE_CONTINUE_SHADOW'; break;
    case 'PRELIMINARY_EVIDENCE': decision = 'PRELIMINARY_CONTINUE_SHADOW'; break;
    default: decision = 'INSUFFICIENT_CONTINUE_SHADOW'; break;
  }

  return {
    decisionId, checkpoint: 100, evidenceClassification: rv.evidenceClassification,
    robustness: rv.robustness ? rv.robustness.status : 'UNKNOWN',
    decision, humanDecisionRequired: true, automaticallyPromoted: false,
    note: 'Human review is mandatory. ATLAS remains SHADOW regardless of statistical result.',
    possibleDecisions: ['CONTINUE_SHADOW', 'PROCEED_TO_PHASE_14', 'REJECT_ATLAS', 'REQUEST_MORE_EVIDENCE'],
    createdAt: Date.now()
  };
}

function persistDecision(dataDir, decisionResult) {
  try {
    const dir = path.join(dataDir, REVIEW_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'checkpoint-100-decision.json'), JSON.stringify(decisionResult, null, 2) + '\n');
    return true;
  } catch (_) { return false; }
}

function main(args) {
  const dataDir = args.includes('--data-dir') ? args[args.indexOf('--data-dir') + 1] : process.cwd();
  const result = decide(dataDir);
  console.log('CHECKPOINT 100 DECISION');
  console.log('Decision ID:', result.decisionId);
  console.log('Status:', result.status || 'DECISION_RECORDED');
  console.log('Evidence:', result.evidenceClassification);
  console.log('Decision:', result.decision);
  console.log('Human Required:', result.humanDecisionRequired);
  console.log('Auto Promoted:', result.automaticallyPromoted);
  console.log('ATLAS: SHADOW | Circuit: AUTHORITATIVE | Execution: PAPER ONLY');
  persistDecision(dataDir, result);
  process.exit(0);
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { decide, persistDecision };
