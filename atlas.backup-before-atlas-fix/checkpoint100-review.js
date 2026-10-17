#!/usr/bin/env node
/**
 * atlas/checkpoint100-review.js — Independent review & robustness gate for Checkpoint 100.
 *
 * Validates the frozen Checkpoint-100 dataset, compares with Checkpoint 30,
 * classifies evidence, and produces human-readable review artifacts.
 *
 * Usage: node atlas/checkpoint100-review.js [--data-dir <path>]
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { analyze, loadFrozenDataset, loadCheckpoint30Dataset, loadStoredHash, computeRobustness, classifyEvidence } = require('./checkpoint100-analysis.js');

const CODE_VERSION = 'ATLAS-0.2.0';
const REVIEW_DIR = 'atlas/reviews';

function sha256Hex(data) { return crypto.createHash('sha256').update(typeof data === 'string' ? data : JSON.stringify(data)).digest('hex'); }
function deterministicReviewId(checkpoint, datasetHash, sampleCount) { return 'EV100-' + sha256Hex(`checkpoint=${checkpoint}&hash=${datasetHash}&n=${sampleCount}`).slice(0, 12).toUpperCase(); }

function review(dataDir) {
  const analysisResult = analyze(dataDir);
  if (analysisResult.status === 'CHECKPOINT_100_NOT_REACHED') {
    return { reviewId: deterministicReviewId(100, 'PENDING', 0), checkpoint: 100, status: 'CHECKPOINT_100_NOT_REACHED', evidenceClassification: 'INSUFFICIENT_EVIDENCE', sampleCount: 0, promotion: { automaticallyPromoted: false, result: 'NOT_READY' }, humanDecision: null };
  }

  const reviewId = deterministicReviewId(100, analysisResult.dataset.datasetHash, analysisResult.sampleCount);
  const humanDecision = { reviewId, decision: null, reviewer: null, reviewTimestamp: null, reason: null, possibleDecisions: ['CONTINUE_SHADOW', 'PROCEED_TO_PHASE_14', 'REJECT_ATLAS', 'REQUEST_MORE_EVIDENCE'], automaticPromotion: false };

  return Object.assign({}, analysisResult, {
    reviewId, checkpoint: 100,
    humanDecision,
    humanReview: {
      whatWeKnow: `We have exactly ${analysisResult.sampleCount} matched observations in the frozen Checkpoint 100 dataset. Primary metric (30m paired difference): mean=${analysisResult.primary.mean}.`,
      whatWeDontKnow: 'Effect stability at 200+ observations, long-term regime persistence, agent drift across extended periods.',
      primaryResult: `30m paired difference: mean=${analysisResult.primary.mean}, CI=[${analysisResult.bootstrap.ciLower}, ${analysisResult.bootstrap.ciUpper}], Cohen's d=${analysisResult.effectSize.d}`,
      importantLimitations: `n=${analysisResult.sampleCount}. Statistical significance != trading usefulness. This is developing evidence. Do not interpret as proof of profitability.`,
      recommendation: analysisResult.evidenceClassification === 'POSITIVE_EVIDENCE' ? 'CONTINUE_SHADOW — positive but needs more evidence.' : analysisResult.evidenceClassification === 'NEGATIVE_EVIDENCE' ? 'REJECT_ATLAS — negative signal.' : 'CONTINUE_SHADOW — continue collecting.'
    }
  });
}

function persistArtifacts(dataDir, reviewResult) {
  try {
    const dir = path.join(dataDir, REVIEW_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'checkpoint-100-review.json'), JSON.stringify(reviewResult, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'checkpoint-100-review.md'), generateMarkdown(reviewResult) + '\n');
    return true;
  } catch (_) { return false; }
}

function generateMarkdown(r) {
  let md = `# CHECKPOINT 100 EVIDENCE REVIEW\n\n`;
  md += `**Review ID:** ${r.reviewId}\n**Checkpoint:** ${r.checkpoint}\n**Dataset Hash:** ${r.dataset ? r.dataset.datasetHash : 'PENDING'}\n**Sample Count:** ${r.sampleCount}\n**Evidence:** ${r.evidenceClassification}\n**Robustness:** ${r.robustness ? r.robustness.status : 'N/A'}\n\n`;
  if (r.primary && r.primary.n > 0) {
    md += `## Primary Metric\n- Mean: ${r.primary.mean}\n- Median: ${r.primary.median}\n- 95% CI: [${r.bootstrap.ciLower}, ${r.bootstrap.ciUpper}]\n- Cohen's d: ${r.effectSize.d} (${r.effectSize.interpretation})\n- Test: ${r.statisticalTest.testName} (p=${r.statisticalTest.pValue})\n\n`;
  }
  if (r.comparison && r.comparison.available) {
    md += `## Checkpoint 30 vs 100\n- Mean shift: ${r.comparison.meanShift}\n- Median shift: ${r.comparison.medianShift}\n- Win rate shift: ${r.comparison.winRateShift}%\n\n`;
  }
  if (r.humanReview) { md += `## WHAT WE KNOW\n${r.humanReview.whatWeKnow}\n\n## IMPORTANT LIMITATIONS\n${r.humanReview.importantLimitations}\n\n## RECOMMENDATION\n${r.humanReview.recommendation}\n\n`; }
  md += `---\n*ATLAS remains SHADOW. Human review required.*\n`;
  return md;
}

function main(args) {
  const dataDir = args.includes('--data-dir') ? args[args.indexOf('--data-dir') + 1] : process.cwd();
  const result = review(dataDir);
  console.log('CHECKPOINT 100 REVIEW');
  console.log('Review ID:', result.reviewId);
  console.log('Status:', result.status || 'REVIEWED');
  console.log('Evidence:', result.evidenceClassification);
  console.log('Robustness:', result.robustness ? result.robustness.status : 'N/A');
  if (result.primary && result.primary.n) console.log('Primary:', result.primary.mean);
  console.log('Promotion:', result.promotion ? (result.promotion.automaticallyPromoted ? 'AUTO' : 'BLOCKED') : 'BLOCKED');
  console.log('ATLAS: SHADOW | Circuit: AUTHORITATIVE | Execution: PAPER ONLY');
  const persisted = persistArtifacts(dataDir, result);
  if (persisted) console.log('Artifacts saved.');
  process.exit(0);
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { review, persistArtifacts, generateMarkdown };
