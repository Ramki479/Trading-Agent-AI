#!/usr/bin/env node
/**
 * atlas/phase14-review.js — Phase 14 review & human decision gate.
 *
 * Consumes the robustness analysis and produces a comprehensive review
 * with human-readable summary and promotion firewall.
 *
 * Usage: node atlas/phase14-review.js [--data-dir <path>]
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { analyze, reproducibilityCheck } = require('./robustness.js');

const REVIEW_DIR = 'atlas/reviews';

function sha256Hex(data) { return crypto.createHash('sha256').update(typeof data === 'string' ? data : JSON.stringify(data)).digest('hex'); }
function deterministicReviewId(datasetHash, sampleCount) { return 'PH14-' + sha256Hex(`hash=${datasetHash}&n=${sampleCount}`).slice(0, 12).toUpperCase(); }

function review(dataDir) {
  const analysis = analyze(dataDir);
  if (analysis.status !== 'ANALYSIS_COMPLETE') {
    return {
      reviewId: deterministicReviewId('PENDING', 0), phase: 14,
      status: analysis.status || 'INSUFFICIENT_EVIDENCE',
      evidenceClassification: 'INSUFFICIENT_EVIDENCE',
      robustness: analysis.robustness || { status: 'INSUFFICIENT_EVIDENCE', issues: ['NO_DATA'] },
      sampleCount: analysis.sampleCount || 0,
      humanDecisionRequired: true, automaticPromotion: false,
      humanReview: { recommendation: 'CONTINUE_SHADOW', whatWeKnow: 'No data available.', limitations: 'Insufficient observations for any analysis.' }
    };
  }

  const reviewId = deterministicReviewId(analysis.datasetHash, analysis.sampleCount);

  const humanReview = {
    whatWeKnow: `We have ${analysis.sampleCount} matched observations. Primary delta30 mean=${analysis.primary.mean}. Robustness classification: ${analysis.robustness.status}.`,
    whatWeDontKnow: 'Long-term regime persistence, agent drift across extended periods, calibration stability beyond current sample.',
    outOfSampleResult: analysis.outOfSample.insufficient ? 'Insufficient OOS data.' : `OOS mean delta=${analysis.outOfSample.stats.mean}, direction consistent=${analysis.outOfSample.directionConsistent}`,
    temporalStability: `Trend: ${analysis.temporal.trend}`,
    regimeRobustness: `${Object.keys(analysis.regimes).length} regimes analyzed.`,
    agentRobustness: `${Object.keys(analysis.agents.agents || {}).length} agents analyzed.`,
    calibration: `${Object.keys(analysis.calibration.buckets).length} buckets analyzed.`,
    overfittingRisks: analysis.overfitting.status,
    limitations: `n=${analysis.sampleCount}. Statistical significance ≠ trading usefulness. Out-of-sample validation is preliminary.`,
    robustnessClassification: analysis.robustness.status,
    recommendation: getRecommendation(analysis)
  };

  return Object.assign({}, analysis, {
    reviewId, phase: 14, evidenceClassification: analysis.robustness.status,
    humanDecisionRequired: true, automaticPromotion: false,
    humanReview,
    promotion: { result: 'NOT_READY', automaticallyPromoted: false, note: 'Human review required. ATLAS remains SHADOW.' }
  });
}

function getRecommendation(analysis) {
  switch (analysis.robustness.status) {
    case 'ROBUST': return 'PROCEED_TO_FINAL_REVIEW — evidence is robust but requires human approval.';
    case 'PARTIALLY_ROBUST': return 'COLLECT_MORE_DATA — evidence shows promise but stability concerns remain.';
    case 'UNSTABLE': return 'ATLAS_NOT_SUPPORTED — evidence is unstable across periods/regimes.';
    case 'NEGATIVE': return 'ATLAS_NOT_SUPPORTED — out-of-sample evidence favors Circuit.';
    case 'INCONCLUSIVE': return 'COLLECT_MORE_DATA — evidence is inconclusive.';
    default: return 'CONTINUE_SHADOW — continue collecting real observations.';
  }
}

function persistArtifacts(dataDir, reviewResult) {
  try {
    const dir = path.join(dataDir, REVIEW_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'phase14-analysis.json'), JSON.stringify(reviewResult, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'phase14-review.json'), JSON.stringify({ reviewId: reviewResult.reviewId, humanReview: reviewResult.humanReview, promotion: reviewResult.promotion, robustness: reviewResult.robustness }, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'phase14-review.md'), generateMarkdown(reviewResult) + '\n');
    return true;
  } catch (_) { return false; }
}

function generateMarkdown(r) {
  let md = `# PHASE 14 ROBUSTNESS REVIEW\n\n`;
  md += `**Review ID:** ${r.reviewId}\n**Sample Count:** ${r.sampleCount}\n**Robustness:** ${r.robustness.status}\n**Issues:** ${r.robustness.issues.join(', ') || 'none'}\n\n`;
  if (r.primary) md += `## Primary Metric\n- Mean: ${r.primary.mean}\n- CI: [${r.bootstrap.ciLower}, ${r.bootstrap.ciUpper}]\n\n`;
  if (r.humanReview) {
    md += `## WHAT WE KNOW\n${r.humanReview.whatWeKnow}\n\n## OUT-OF-SAMPLE\n${r.humanReview.outOfSampleResult}\n\n## TEMPORAL STABILITY\n${r.humanReview.temporalStability}\n\n## LIMITATIONS\n${r.humanReview.limitations}\n\n## RECOMMENDATION\n${r.humanReview.recommendation}\n\n`;
  }
  md += `---\n*ATLAS remains SHADOW. Human review required.*\n`;
  return md;
}

function main(args) {
  const dataDir = args.includes('--data-dir') ? args[args.indexOf('--data-dir') + 1] : process.cwd();
  const result = review(dataDir);
  console.log('PHASE 14 REVIEW');
  console.log('Review ID:', result.reviewId);
  console.log('Robustness:', result.robustness.status);
  console.log('Recommendation:', result.humanReview ? result.humanReview.recommendation : 'N/A');
  console.log('Human Required:', result.humanDecisionRequired);
  console.log('Auto Promoted:', result.automaticPromotion);
  console.log('ATLAS: SHADOW | Circuit: AUTHORITATIVE | Execution: PAPER ONLY');
  persistArtifacts(dataDir, result);
  process.exit(0);
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { review, persistArtifacts, generateMarkdown };
